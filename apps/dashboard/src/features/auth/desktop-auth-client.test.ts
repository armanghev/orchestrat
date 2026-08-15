import { describe, expect, it, vi } from "vitest";
import { DesktopAuthClient } from "./desktop-auth-client";

const grant = { accessToken: "access-1", expiresAtMs: 60_000 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(restored: typeof grant | null = null) {
  let callback: ((url: URL) => void) | undefined;
  const bridge = {
    beginGitHub: vi.fn(async () => undefined),
    sendMagicLink: vi.fn(async () => undefined),
    complete: vi.fn(async () => grant),
    refresh: vi.fn(async () => ({ ...grant, accessToken: "access-2" })),
    restore: vi.fn(async () => restored),
    expire: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined)
  };
  const platform = {
    kind: "desktop" as const,
    preferences: { load: vi.fn(), save: vi.fn() },
    openExternal: vi.fn(async () => undefined),
    onAuthCallback: vi.fn(async (handler: (url: URL) => void) => {
      callback = handler;
      return () => { callback = undefined; };
    })
  };
  return { bridge, platform, getCallback: () => callback };
}

describe("DesktopAuthClient", () => {
  it("restores, opens the browser, completes a callback, refreshes, and signs out", async () => {
    const f = fixture();
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    expect(client.getSnapshot()).toEqual({ status: "signedOut" });

    expect(client.capabilities).toEqual({ github: true, magicLink: true });
    await client.signInWithGitHub();
    expect(client.getSnapshot()).toEqual({ status: "signingIn" });
    expect(f.bridge.beginGitHub).toHaveBeenCalledOnce();
    expect(f.platform.openExternal).not.toHaveBeenCalled();

    await client.completeSignIn(
      "dev.orchestrat.app://auth/callback?code=a&sb_flow_id=b"
    );
    expect(client.getSnapshot()).toMatchObject({ status: "signedIn" });
    expect(await client.getAccessToken()).toBe("access-1");
    const identityBeforeRefresh = (client.getSnapshot() as { identityKey: string }).identityKey;
    expect(await client.getAccessToken({ forceRefresh: true })).toBe("access-2");
    expect((client.getSnapshot() as { identityKey: string }).identityKey).toBe(identityBeforeRefresh);

    await client.signOut();
    expect(client.getSnapshot()).toEqual({ status: "signedOut" });
    expect(await client.getAccessToken()).toBeNull();
  });

  it("converts rejected callbacks into stable errors", async () => {
    const f = fixture();
    f.bridge.complete.mockRejectedValue({
      code: "flow_mismatch",
      message: "The callback flow does not match."
    });
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    await client.completeSignIn(
      "dev.orchestrat.app://auth/callback?code=a&sb_flow_id=wrong"
    );
    expect(client.getSnapshot()).toEqual({
      status: "error",
      code: "flow_mismatch",
      message: "The callback flow does not match."
    });
  });


  it("lets a cold callback synchronously own auth before subscription and restore settle", async () => {
    const f = fixture({ accessToken: "old-restored", expiresAtMs: 60_000 });
    const subscription = deferred<() => void>();
    const completion = deferred<typeof grant>();
    f.platform.onAuthCallback.mockImplementation((handler) => {
      handler(new URL("dev.orchestrat.app://auth/callback?code=cold&sb_flow_id=fresh"));
      return subscription.promise;
    });
    f.bridge.complete.mockReturnValueOnce(completion.promise);
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    const initializing = client.initialize();

    expect(client.getSnapshot()).toEqual({ status: "signingIn" });
    expect(await client.getAccessToken()).toBeNull();
    expect(f.bridge.restore).not.toHaveBeenCalled();
    subscription.resolve(vi.fn());
    await initializing;
    expect(f.bridge.restore).not.toHaveBeenCalled();
    expect(client.getSnapshot()).toEqual({ status: "signingIn" });

    completion.resolve({ accessToken: "callback-new", expiresAtMs: 60_000 });
    await vi.waitFor(() => expect(client.getSnapshot()).toMatchObject({ status: "signedIn" }));
    expect(await client.getAccessToken()).toBe("callback-new");
  });

  it("leaves no restored grant or token when a cold callback fails", async () => {
    const f = fixture({ accessToken: "must-not-restore", expiresAtMs: 60_000 });
    const subscription = deferred<() => void>();
    const completion = deferred<typeof grant>();
    f.platform.onAuthCallback.mockImplementation((handler) => {
      handler(new URL("dev.orchestrat.app://auth/callback?code=cold-failure&sb_flow_id=fresh"));
      return subscription.promise;
    });
    f.bridge.complete.mockReturnValueOnce(completion.promise);
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    const initializing = client.initialize();
    subscription.resolve(vi.fn());
    await initializing;
    completion.reject({ code: "callback_failed", message: "Try again." });
    await vi.waitFor(() => expect(client.getSnapshot()).toEqual({ status: "error", code: "callback_failed", message: "Try again." }));
    expect(f.bridge.restore).not.toHaveBeenCalled();
    expect(await client.getAccessToken()).toBeNull();
  });

  it("clears a warm grant synchronously and changes identity only when callback B completes", async () => {
    const f = fixture(grant);
    const completion = deferred<typeof grant>();
    f.bridge.complete.mockReturnValueOnce(completion.promise);
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    const first = client.getSnapshot();
    expect(first).toMatchObject({ status: "signedIn" });

    f.getCallback()?.(new URL("dev.orchestrat.app://auth/callback?code=switch&sb_flow_id=fresh"));
    expect(client.getSnapshot()).toEqual({ status: "signingIn" });
    expect(await client.getAccessToken()).toBeNull();
    completion.resolve({ accessToken: "account-b", expiresAtMs: 60_000 });
    await vi.waitFor(() => expect(client.getSnapshot()).toMatchObject({ status: "signedIn" }));
    expect((client.getSnapshot() as { identityKey: string }).identityKey).not.toBe((first as { identityKey: string }).identityKey);
  });

  it("refreshes automatically when fewer than 30 seconds remain", async () => {
    const f = fixture({ ...grant, expiresAtMs: 30_999 });
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();

    expect(await client.getAccessToken()).toBe("access-2");
    expect(f.bridge.refresh).toHaveBeenCalledOnce();
  });

  it("expires the native session when refresh fails terminally", async () => {
    const f = fixture({ ...grant, expiresAtMs: 1_001 });
    f.bridge.refresh.mockRejectedValue({ code: "provider_rejected", message: "Sign in again." });
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();

    expect(await client.getAccessToken()).toBeNull();
    expect(client.getSnapshot()).toEqual({ status: "signedOut" });
    expect(f.bridge.expire).toHaveBeenCalledOnce();
  });

  it("preserves the native refresh session after a transient refresh failure", async () => {
    const f = fixture({ ...grant, expiresAtMs: 1_001 });
    f.bridge.refresh.mockRejectedValue({ code: "provider_unavailable", message: "Try again." });
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    expect(await client.getAccessToken()).toBeNull();
    expect(f.bridge.expire).not.toHaveBeenCalled();
    expect(client.getSnapshot()).toEqual({ status: "error", code: "provider_unavailable", message: "Try again." });
  });

  it("makes restore failures recoverable errors", async () => {
    const f = fixture();
    f.bridge.restore.mockRejectedValue({ code: "restore_failed", message: "Try again." });
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);

    await client.initialize();
    expect(client.getSnapshot()).toEqual({
      status: "error", code: "restore_failed", message: "Try again."
    });
    await client.signInWithGitHub();
    expect(f.bridge.beginGitHub).toHaveBeenCalledOnce();
  });

  it("completes each subscribed deep link once", async () => {
    const f = fixture();
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    const callback = f.getCallback();
    expect(callback).toBeDefined();

    callback?.(new URL("dev.orchestrat.app://auth/callback?code=a&sb_flow_id=b"));
    await vi.waitFor(() => expect(client.getSnapshot()).toMatchObject({ status: "signedIn" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    callback?.(new URL("dev.orchestrat.app://auth/callback?code=a&sb_flow_id=b"));
    await Promise.resolve();
    expect(f.bridge.complete).toHaveBeenCalledOnce();
  });


  it("accepts a new GitHub callback after a local sign-out", async () => {
    const f = fixture();
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    await client.signOut();
    await client.signInWithGitHub();
    f.getCallback()?.(new URL("dev.orchestrat.app://auth/callback?code=new&sb_flow_id=fresh"));
    await vi.waitFor(() => expect(client.getSnapshot()).toMatchObject({ status: "signedIn" }));
    expect(f.bridge.complete).toHaveBeenCalledOnce();
  });

  it("ignores callbacks after disposal", async () => {
    const f = fixture();
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    const callback = f.getCallback();

    client.dispose();
    callback?.(new URL("dev.orchestrat.app://auth/callback?code=a&sb_flow_id=b"));
    await Promise.resolve();

    expect(f.bridge.complete).not.toHaveBeenCalled();
  });

  it("unlistens when a callback subscription resolves after disposal", async () => {
    let resolveSubscription: ((unlisten: () => void) => void) | undefined;
    const unlisten = vi.fn();
    const f = fixture();
    f.platform.onAuthCallback.mockImplementation(() => new Promise((resolve) => {
      resolveSubscription = resolve;
    }));
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    const initializing = client.initialize();

    client.dispose();
    resolveSubscription?.(unlisten);
    await initializing;

    expect(unlisten).toHaveBeenCalledOnce();
  });


  it("normalizes, coalesces, and reports an accepted native magic link", async () => {
    const f = fixture();
    const sending = deferred<undefined>();
    f.bridge.sendMagicLink.mockReturnValueOnce(sending.promise);
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    const first = client.sendMagicLink("  Person@Example.COM  ");
    const second = client.sendMagicLink("person@example.com");
    expect(first).toBe(second);
    expect(client.getSnapshot()).toEqual({ status: "sendingMagicLink", email: "person@example.com" });
    expect(f.bridge.sendMagicLink).toHaveBeenCalledWith("person@example.com");
    sending.resolve(undefined);
    await first;
    expect(client.getSnapshot()).toEqual({ status: "magicLinkSent", email: "person@example.com" });
  });

  it("clears the Rust-owned refresh session when the API expires auth", async () => {
    const f = fixture(grant);
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    await client.expireSession();
    expect(f.bridge.expire).toHaveBeenCalledOnce();
    expect(client.getSnapshot()).toEqual({ status: "signedOut" });
  });

  it("proactively refreshes once before expiry and coalesces forced refresh", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ ...grant, expiresAtMs: 61_000 });
      const refreshed = deferred<typeof grant>();
      f.bridge.refresh.mockReturnValueOnce(refreshed.promise);
      const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
      await client.initialize();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.bridge.refresh).toHaveBeenCalledOnce();
      const forced = client.getAccessToken({ forceRefresh: true });
      expect(f.bridge.refresh).toHaveBeenCalledOnce();
      refreshed.resolve({ accessToken: "access-2", expiresAtMs: 120_000 });
      expect(await forced).toBe("access-2");
      client.dispose();
    } finally { vi.useRealTimers(); }
  });


  it("clears proactive refresh timers on sign-out, expiry, and disposal", async () => {
    vi.useFakeTimers();
    try {
      for (const action of ["signOut", "expire", "dispose"] as const) {
        const f = fixture({ ...grant, expiresAtMs: 61_000 });
        const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
        await client.initialize();
        if (action === "signOut") await client.signOut();
        else if (action === "expire") await client.expireSession();
        else client.dispose();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(f.bridge.refresh).not.toHaveBeenCalled();
      }
    } finally { vi.useRealTimers(); }
  });

});
