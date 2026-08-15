import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { ProviderTokenStrippingStorage } from "./web-auth-storage";
import { WebAuthClient, createBrowserWebAuthClient, type WebAuthApi } from "./web-auth-client";

const callbackUrl = "https://dashboard.example.com/auth/callback";

function session(token = "supabase-access"): Session {
  return {
    access_token: token,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: 4_000_000_000,
    refresh_token: "supabase-refresh",
    user: {
      id: "user-1", app_metadata: {}, user_metadata: {}, aud: "authenticated",
      created_at: "2026-01-01T00:00:00.000Z"
    }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(restored: Session | null = null) {
  let authChange: ((event: AuthChangeEvent, session: Session | null) => void) | undefined;
  const unsubscribe = vi.fn();
  const auth = {
    onAuthStateChange: vi.fn((listener: (event: AuthChangeEvent, session: Session | null) => void) => {
      authChange = listener;
      return { data: { subscription: { unsubscribe } } };
    }),
    getSession: vi.fn(async () => ({ data: { session: restored }, error: null })),
    signInWithOAuth: vi.fn(async () => ({ data: { provider: "github", url: "https://github.example" }, error: null })),
    signInWithOtp: vi.fn(async () => ({ data: { user: null, session: null, messageId: "accepted" }, error: null })),
    exchangeCodeForSession: vi.fn(async () => ({ data: { session: session(), user: session().user }, error: null })),
    refreshSession: vi.fn(async () => ({ data: { session: session("refreshed-access"), user: session().user }, error: null })),
    signOut: vi.fn(async () => ({ error: null }))
  };
  const client = new WebAuthClient(auth as WebAuthApi, callbackUrl);
  return { auth, client, unsubscribe, emit: (event: AuthChangeEvent, value: Session | null) => authChange?.(event, value) };
}

describe("WebAuthClient", () => {
  it.each([[null, "signedOut"], [session(), "signedIn"]] as const)(
    "initializes a restored %s session as %s",
    async (restored, status) => {
      const f = fixture(restored);
      const first = f.client.initialize();
      const second = f.client.initialize();
      expect(first).toBe(second);
      await first;
      expect(f.auth.onAuthStateChange).toHaveBeenCalledOnce();
      expect(f.auth.getSession).toHaveBeenCalledOnce();
      expect(f.client.getSnapshot().status).toBe(status);
    }
  );


  it("does not overwrite a synchronous auth event with an older restored session", async () => {
    const f = fixture(null);
    f.auth.onAuthStateChange.mockImplementationOnce((listener) => {
      listener("SIGNED_IN", session("event-access"));
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    await f.client.initialize();
    expect(f.client.getSnapshot()).toEqual({ status: "signedIn" });
    expect(await f.client.getAccessToken()).toBe("event-access");
  });

  it("maps auth events, keeps equal snapshots stable, and unsubscribes on dispose", async () => {
    const f = fixture();
    const listener = vi.fn();
    const stop = f.client.subscribe(listener);
    await f.client.initialize();
    const signedOut = f.client.getSnapshot();
    f.emit("SIGNED_OUT", null);
    expect(f.client.getSnapshot()).toBe(signedOut);
    f.emit("SIGNED_IN", session());
    expect(f.client.getSnapshot()).toEqual({ status: "signedIn" });
    f.emit("TOKEN_REFRESHED", session("new-access"));
    expect(await f.client.getAccessToken()).toBe("new-access");
    stop();
    f.client.dispose();
    f.emit("SIGNED_OUT", null);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("starts GitHub OAuth once with the exact configured callback", async () => {
    const f = fixture();
    await f.client.initialize();
    const pending = deferred<{ data: { provider: "github"; url: string }; error: null }>();
    f.auth.signInWithOAuth.mockReturnValueOnce(pending.promise);
    const first = f.client.signInWithGitHub();
    const second = f.client.signInWithGitHub();
    expect(first).toBe(second);
    expect(f.client.getSnapshot()).toEqual({ status: "signingIn" });
    expect(f.auth.signInWithOAuth).toHaveBeenCalledWith({ provider: "github", options: { redirectTo: callbackUrl } });
    pending.resolve({ data: { provider: "github", url: "https://github.example" }, error: null });
    await first;
    expect(f.auth.signInWithOAuth).toHaveBeenCalledOnce();
  });


  it("keeps a SIGNED_IN event authoritative over an older GitHub failure", async () => {
    const f = fixture();
    await f.client.initialize();
    const pending = deferred<{ data: { provider: "github"; url: null }; error: unknown }>();
    f.auth.signInWithOAuth.mockReturnValueOnce(pending.promise as never);
    const request = f.client.signInWithGitHub();
    f.emit("SIGNED_IN", session("github-event-token"));
    pending.resolve({ data: { provider: "github", url: null }, error: new Error("stale OAuth failure") });
    await request;
    expect(f.client.getSnapshot()).toEqual({ status: "signedIn" });
    expect(await f.client.getAccessToken()).toBe("github-event-token");
  });

  it("normalizes and sends a magic link once, then reports request acceptance", async () => {
    const f = fixture();
    await f.client.initialize();
    const pending = deferred<{ data: { user: null; session: null; messageId: string }; error: null }>();
    f.auth.signInWithOtp.mockReturnValueOnce(pending.promise);
    const first = f.client.sendMagicLink("  Person@Example.COM  ");
    const second = f.client.sendMagicLink("person@example.com");
    expect(first).toBe(second);
    expect(f.client.getSnapshot()).toEqual({ status: "sendingMagicLink", email: "person@example.com" });
    expect(f.auth.signInWithOtp).toHaveBeenCalledWith({
      email: "person@example.com",
      options: { emailRedirectTo: callbackUrl, shouldCreateUser: true }
    });
    pending.resolve({ data: { user: null, session: null, messageId: "accepted" }, error: null });
    await first;
    expect(f.client.getSnapshot()).toEqual({ status: "magicLinkSent", email: "person@example.com" });
    expect(f.auth.signInWithOtp).toHaveBeenCalledOnce();
  });


  it("keeps a SIGNED_IN event authoritative when an older OTP request resolves", async () => {
    const f = fixture();
    await f.client.initialize();
    const pending = deferred<{ data: { user: null; session: null; messageId: string }; error: null }>();
    f.auth.signInWithOtp.mockReturnValueOnce(pending.promise);
    const request = f.client.sendMagicLink("person@example.com");
    f.emit("SIGNED_IN", session("event-signed-in"));
    pending.resolve({ data: { user: null, session: null, messageId: "accepted" }, error: null });
    await request;
    expect(f.client.getSnapshot()).toEqual({ status: "signedIn" });
    expect(await f.client.getAccessToken()).toBe("event-signed-in");
  });

  it.each(["success", "failure"] as const)(
    "keeps a SIGNED_OUT event authoritative when an older OTP request ends with %s",
    async (outcome) => {
      const f = fixture();
      await f.client.initialize();
      const pending = deferred<{ data: { user: null; session: null; messageId?: string }; error: unknown }>();
      f.auth.signInWithOtp.mockReturnValueOnce(pending.promise as never);
      const request = f.client.sendMagicLink("person@example.com");
      f.emit("SIGNED_OUT", null);
      pending.resolve(outcome === "success"
        ? { data: { user: null, session: null, messageId: "accepted" }, error: null }
        : { data: { user: null, session: null }, error: new Error("old OTP failure") });
      await request;
      expect(f.client.getSnapshot()).toEqual({ status: "signedOut" });
    }
  );

  it("does not let an older OTP failure overwrite a newer GitHub flow", async () => {
    const f = fixture();
    const pending = deferred<{ data: { user: null; session: null }; error: unknown }>();
    f.auth.signInWithOtp.mockReturnValueOnce(pending.promise as never);
    const otp = f.client.sendMagicLink("person@example.com");
    await f.client.signInWithGitHub();
    pending.resolve({ data: { user: null, session: null }, error: new Error("old OTP failure") });
    await otp;
    expect(f.client.getSnapshot()).toEqual({ status: "signingIn" });
  });

  it.each(["", "not-an-email", "a@b", `${"a".repeat(245)}@example.com`, "first@example.com,second@example.com"])(
    "rejects invalid email without making a request: %s",
    async (email) => {
      const f = fixture();
      await f.client.sendMagicLink(email);
      expect(f.auth.signInWithOtp).not.toHaveBeenCalled();
      expect(f.client.getSnapshot()).toEqual({
        status: "error", code: "invalid_email", message: "Enter a valid email address."
      });
    }
  );

  it("exchanges an exact callback code once across concurrent completion", async () => {
    const f = fixture();
    const pending = deferred<{ data: { session: Session; user: Session["user"] }; error: null }>();
    f.auth.exchangeCodeForSession.mockReturnValueOnce(pending.promise);
    const first = f.client.completeSignIn(`${callbackUrl}?code=one-time-code`);
    const second = f.client.completeSignIn(`${callbackUrl}?code=one-time-code`);
    expect(first).toBe(second);
    expect(f.client.getSnapshot()).toEqual({ status: "signingIn" });
    expect(f.auth.exchangeCodeForSession).toHaveBeenCalledOnce();
    expect(f.auth.exchangeCodeForSession).toHaveBeenCalledWith("one-time-code");
    pending.resolve({ data: { session: session(), user: session().user }, error: null });
    await first;
    await f.client.completeSignIn(`${callbackUrl}?code=ignored-after-success`);
    expect(f.auth.exchangeCodeForSession).toHaveBeenCalledOnce();
    expect(f.client.getSnapshot()).toEqual({ status: "signedIn" });
  });


  it("makes a failed accepted callback terminal until a genuinely new auth flow starts", async () => {
    const f = fixture();
    f.auth.exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: null, user: null }, error: new Error("old exchange failure")
    } as never);
    await f.client.completeSignIn(`${callbackUrl}?code=failed-once`);
    const failedSnapshot = f.client.getSnapshot();
    await f.client.completeSignIn(`${callbackUrl}?code=must-not-retry`);
    expect(f.auth.exchangeCodeForSession).toHaveBeenCalledOnce();
    expect(f.client.getSnapshot()).toBe(failedSnapshot);

    await f.client.signInWithGitHub();
    await f.client.completeSignIn(`${callbackUrl}?code=new-flow-code`);
    expect(f.auth.exchangeCodeForSession).toHaveBeenCalledTimes(2);
    expect(f.client.getSnapshot()).toEqual({ status: "signedIn" });
  });

  it("keeps an auth event authoritative over a callback exchange failure", async () => {
    const f = fixture();
    await f.client.initialize();
    const pending = deferred<{ data: { session: null; user: null }; error: unknown }>();
    f.auth.exchangeCodeForSession.mockReturnValueOnce(pending.promise as never);
    const exchange = f.client.completeSignIn(`${callbackUrl}?code=event-owned`);
    f.emit("SIGNED_IN", session("callback-event-token"));
    pending.resolve({ data: { session: null, user: null }, error: new Error("stale callback failure") });
    await exchange;
    expect(f.client.getSnapshot()).toEqual({ status: "signedIn" });
    expect(await f.client.getAccessToken()).toBe("callback-event-token");
  });


  it("keeps the SIGNED_IN event emitted by callback exchange authoritative over its result", async () => {
    const f = fixture();
    await f.client.initialize();
    f.auth.exchangeCodeForSession.mockImplementationOnce(async () => {
      f.emit("SIGNED_IN", session("exchange-event-token"));
      return { data: { session: session("stale-exchange-token"), user: session().user }, error: null };
    });
    await f.client.completeSignIn(`${callbackUrl}?code=emits-event`);
    expect(f.client.getSnapshot()).toEqual({ status: "signedIn" });
    expect(await f.client.getAccessToken()).toBe("exchange-event-token");
  });

  it("also resets callback attempt terminality when a new magic-link flow starts", async () => {
    const f = fixture();
    f.auth.exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: null, user: null }, error: new Error("first exchange failure")
    } as never);
    await f.client.completeSignIn(`${callbackUrl}?code=failed-magic-predecessor`);
    await f.client.sendMagicLink("person@example.com");
    await f.client.completeSignIn(`${callbackUrl}?code=new-magic-flow`);
    expect(f.auth.exchangeCodeForSession).toHaveBeenCalledTimes(2);
    expect(f.client.getSnapshot()).toEqual({ status: "signedIn" });
  });

  it.each([
    "https://foreign.example.com/auth/callback?code=x",
    "https://dashboard.example.com:444/auth/callback?code=x",
    "https://dashboard.example.com/auth/callback?code=x#fragment",
    "https://user@dashboard.example.com/auth/callback?code=x",
    "https://dashboard.example.com/auth/callback?code=a&code=b",
    "https://dashboard.example.com/auth/callback?code=x&state=unknown",
    "https://dashboard.example.com/auth/callback?error=denied&code=x",
    "https://dashboard.example.com/auth/callback?error_code=denied"
  ])("rejects unsafe callback shapes without exchanging: %s", async (url) => {
    const f = fixture();
    await f.client.completeSignIn(url);
    expect(f.auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(f.client.getSnapshot()).toEqual({
      status: "error", code: "invalid_callback", message: "We couldn't complete your sign-in. Try again."
    });
  });

  it("turns sanitized provider callback errors into a stable generic error", async () => {
    const f = fixture();
    await f.client.completeSignIn(`${callbackUrl}?error=access_denied&error_code=oauth_denied&error_description=private%20provider%20details`);
    expect(f.auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(f.client.getSnapshot()).toEqual({
      status: "error", code: "provider_error", message: "We couldn't complete your sign-in. Try again."
    });
    expect(JSON.stringify(f.client.getSnapshot())).not.toContain("private provider details");
  });

  it("returns the cached token and coalesces a forced Supabase refresh", async () => {
    const f = fixture(session());
    await f.client.initialize();
    expect(await f.client.getAccessToken()).toBe("supabase-access");
    const pending = deferred<{ data: { session: Session; user: Session["user"] }; error: null }>();
    f.auth.refreshSession.mockReturnValueOnce(pending.promise);
    const first = f.client.getAccessToken({ forceRefresh: true });
    const second = f.client.getAccessToken({ forceRefresh: true });
    expect(first).toBe(second);
    pending.resolve({ data: { session: session("refreshed-access"), user: session().user }, error: null });
    expect(await first).toBe("refreshed-access");
    expect(f.auth.refreshSession).toHaveBeenCalledOnce();
  });


  it("keeps a SIGNED_OUT event authoritative over an older refresh success", async () => {
    const f = fixture(session());
    await f.client.initialize();
    const pending = deferred<{ data: { session: Session; user: Session["user"] }; error: null }>();
    f.auth.refreshSession.mockReturnValueOnce(pending.promise);
    const refresh = f.client.getAccessToken({ forceRefresh: true });
    f.emit("SIGNED_OUT", null);
    pending.resolve({ data: { session: session("stale-refresh"), user: session().user }, error: null });
    expect(await refresh).toBeNull();
    expect(f.client.getSnapshot()).toEqual({ status: "signedOut" });
  });

  it("keeps a TOKEN_REFRESHED event authoritative over an older refresh failure", async () => {
    const f = fixture(session());
    await f.client.initialize();
    const pending = deferred<{ data: { session: null; user: null }; error: unknown }>();
    f.auth.refreshSession.mockReturnValueOnce(pending.promise as never);
    const refresh = f.client.getAccessToken({ forceRefresh: true });
    f.emit("TOKEN_REFRESHED", session("event-refreshed"));
    pending.resolve({ data: { session: null, user: null }, error: new Error("stale refresh failure") });
    expect(await refresh).toBe("event-refreshed");
    expect(f.auth.signOut).not.toHaveBeenCalled();
    expect(f.client.getSnapshot()).toEqual({ status: "signedIn" });
  });

  it("expires the local session after refresh failure", async () => {
    const f = fixture(session());
    await f.client.initialize();
    f.auth.refreshSession.mockResolvedValueOnce({ data: { session: null, user: null }, error: new Error("private failure") } as never);
    expect(await f.client.getAccessToken({ forceRefresh: true })).toBeNull();
    expect(f.client.getSnapshot()).toEqual({ status: "signedOut" });
    expect(f.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("coalesces sign-out and expiry and affects only the local Supabase session", async () => {
    const f = fixture(session());
    await f.client.initialize();
    const pending = deferred<{ error: null }>();
    f.auth.signOut.mockReturnValueOnce(pending.promise);
    const first = f.client.signOut();
    const second = f.client.expireSession();
    expect(first).toBe(second);
    expect(f.client.getSnapshot()).toEqual({ status: "signedOut" });
    expect(await f.client.getAccessToken()).toBeNull();
    expect(f.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    pending.resolve({ error: null });
    await first;
    expect(f.auth.signOut).toHaveBeenCalledOnce();
    f.emit("SIGNED_IN", session("next-session"));
    expect(f.client.getSnapshot()).toEqual({ status: "signedIn" });
    expect(await f.client.getAccessToken()).toBe("next-session");
  });
});

describe("createBrowserWebAuthClient", () => {
  it("creates Supabase once with PKCE persistence and provider-token-safe storage", () => {
    const auth = fixture().auth;
    const createClient = vi.fn(() => ({ auth }));
    const backing = window.localStorage;
    const client = createBrowserWebAuthClient(
      "https://project.supabase.co", "sb_publishable_test", callbackUrl, backing,
      createClient as unknown as Parameters<typeof createBrowserWebAuthClient>[4]
    );
    expect(client).toBeInstanceOf(WebAuthClient);
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith(
      "https://project.supabase.co", "sb_publishable_test",
      { auth: expect.objectContaining({
        flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false,
        storage: expect.any(ProviderTokenStrippingStorage)
      }) }
    );
  });
});
