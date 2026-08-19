import { describe, expect, it, vi } from "vitest";
import { DesktopAuthClient } from "./desktop-auth-client";

const grant = { accessToken: "access-1", expiresAtMs: 60_000 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(restored: typeof grant | null = null) {
  let callback: ((url: URL) => void) | undefined;
  const bridge = {
    beginGitHub: vi.fn(async () => undefined),
    sendMagicLink: vi.fn(async () => undefined),
    complete: vi.fn(async (callback: string) => {
      void callback;
      return grant;
    }),
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
      return () => {
        callback = undefined;
      };
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

    expect(client.capabilities).toEqual({
      github: true,
      magicLink: false,
      browserPortal: true
    });
    await client.signInWithGitHub();
    expect(client.getSnapshot()).toEqual({ status: "signingIn" });
    expect(f.bridge.beginGitHub).toHaveBeenCalledOnce();
    expect(f.platform.openExternal).not.toHaveBeenCalled();

    await client.completeSignIn(
      "dev.orchestrat.app://auth/callback?code=a&sb_flow_id=b"
    );
    expect(client.getSnapshot()).toMatchObject({ status: "signedIn" });
    expect(await client.getAccessToken()).toBe("access-1");
    const identityBeforeRefresh = (
      client.getSnapshot() as { identityKey: string }
    ).identityKey;
    expect(await client.getAccessToken({ forceRefresh: true })).toBe(
      "access-2"
    );
    expect((client.getSnapshot() as { identityKey: string }).identityKey).toBe(
      identityBeforeRefresh
    );

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
      handler(
        new URL("dev.orchestrat.app://auth/callback?code=cold&sb_flow_id=fresh")
      );
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
    await vi.waitFor(() =>
      expect(client.getSnapshot()).toMatchObject({ status: "signedIn" })
    );
    expect(await client.getAccessToken()).toBe("callback-new");
  });

  it("leaves no restored grant or token when a cold callback fails", async () => {
    const f = fixture({ accessToken: "must-not-restore", expiresAtMs: 60_000 });
    const subscription = deferred<() => void>();
    const completion = deferred<typeof grant>();
    f.platform.onAuthCallback.mockImplementation((handler) => {
      handler(
        new URL(
          "dev.orchestrat.app://auth/callback?code=cold-failure&sb_flow_id=fresh"
        )
      );
      return subscription.promise;
    });
    f.bridge.complete.mockReturnValueOnce(completion.promise);
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    const initializing = client.initialize();
    subscription.resolve(vi.fn());
    await initializing;
    completion.reject({ code: "callback_failed", message: "Try again." });
    await vi.waitFor(() =>
      expect(client.getSnapshot()).toEqual({
        status: "error",
        code: "callback_failed",
        message: "Try again."
      })
    );
    expect(f.bridge.restore).not.toHaveBeenCalled();
    expect(await client.getAccessToken()).toBeNull();
  });

  it("preserves a warm grant through mismatched callbacks during active GitHub and magic operations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      for (const method of ["github", "magic"] as const) {
        vi.setSystemTime(1_000);
        const f = fixture(grant);
        const active = deferred<undefined>();
        if (method === "github")
          f.bridge.beginGitHub.mockReturnValueOnce(active.promise);
        else f.bridge.sendMagicLink.mockReturnValueOnce(active.promise);
        f.bridge.complete.mockRejectedValueOnce({
          code: "flow_mismatch",
          message: "The callback flow does not match."
        });
        const client = new DesktopAuthClient(f.platform, f.bridge, Date.now);
        await client.initialize();
        const identity = (client.getSnapshot() as { identityKey: string })
          .identityKey;
        if (method === "github") void client.signInWithGitHub();
        else void client.sendMagicLink("person@example.com");

        await expect(
          client.completeSignIn(
            `dev.orchestrat.app://auth/callback?code=bad-${method}&sb_flow_id=wrong-${method}`
          )
        ).resolves.toEqual({ status: "error" });
        expect(client.getSnapshot()).toEqual({
          status: "signedIn",
          identityKey: identity
        });
        expect(await client.getAccessToken()).toBe("access-1");
        await vi.advanceTimersByTimeAsync(28_999);
        expect(f.bridge.refresh).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(f.bridge.refresh).toHaveBeenCalledOnce();
        active.resolve(undefined);
        await Promise.resolve();
        client.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a warm grant until a correlated account switch succeeds", async () => {
    const f = fixture(grant);
    const completion = deferred<typeof grant>();
    f.bridge.complete.mockReturnValueOnce(completion.promise);
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    const first = client.getSnapshot();
    expect(first).toMatchObject({ status: "signedIn" });

    f.getCallback()?.(
      new URL("dev.orchestrat.app://auth/callback?code=switch&sb_flow_id=fresh")
    );
    expect(client.getSnapshot()).toEqual(first);
    expect(await client.getAccessToken()).toBe("access-1");
    completion.resolve({ accessToken: "account-b", expiresAtMs: 60_000 });
    await vi.waitFor(() =>
      expect(client.getSnapshot()).toMatchObject({ status: "signedIn" })
    );
    expect(await client.getAccessToken()).toBe("account-b");
    expect(
      (client.getSnapshot() as { identityKey: string }).identityKey
    ).not.toBe((first as { identityKey: string }).identityKey);
  });

  it("keeps a warm token and identity after a mismatched untrusted callback", async () => {
    const f = fixture(grant);
    f.bridge.complete.mockRejectedValue({
      code: "flow_mismatch",
      message: "The callback flow does not match."
    });
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    const before = client.getSnapshot();
    const result = await client.completeSignIn(
      "dev.orchestrat.app://auth/callback?code=untrusted&sb_flow_id=wrong"
    );
    expect(result).toEqual({ status: "error" });
    expect(client.getSnapshot()).toEqual(before);
    expect(await client.getAccessToken()).toBe("access-1");
  });

  it("refreshes automatically when fewer than 30 seconds remain", async () => {
    const f = fixture({ ...grant, expiresAtMs: 30_999 });
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();

    expect(await client.getAccessToken()).toBe("access-2");
    expect(f.bridge.refresh).toHaveBeenCalledOnce();
  });

  it("maps a forced caller coalesced with transient proactive refresh to null", async () => {
    const f = fixture({ accessToken: "old-access", expiresAtMs: 20_000 });
    const refreshing = deferred<typeof grant>();
    f.bridge.refresh.mockReturnValueOnce(refreshing.promise);
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();

    const proactive = client.getAccessToken();
    const forced = client.getAccessToken({ forceRefresh: true });
    expect(f.bridge.refresh).toHaveBeenCalledOnce();
    refreshing.reject({ code: "provider_unavailable", message: "Try again." });
    await expect(proactive).resolves.toBe("old-access");
    await expect(forced).resolves.toBeNull();
    expect(f.bridge.expire).not.toHaveBeenCalled();
    client.dispose();
  });

  it("does not proactively refresh a warm session while exchange retry is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const f = fixture({ accessToken: "account-a", expiresAtMs: 61_000 });
      f.bridge.complete
        .mockRejectedValueOnce({
          code: "provider_unavailable",
          message: "Try again."
        })
        .mockResolvedValueOnce({
          accessToken: "account-b",
          expiresAtMs: 300_000
        });
      const client = new DesktopAuthClient(f.platform, f.bridge, Date.now);
      await client.initialize();
      const identityA = (client.getSnapshot() as { identityKey: string })
        .identityKey;

      await expect(
        client.completeSignIn(
          "dev.orchestrat.app://auth/callback?code=uncertain&sb_flow_id=flow-a"
        )
      ).resolves.toEqual({ status: "error" });
      expect(await client.getAccessToken()).toBe("account-a");
      expect(await client.getAccessToken({ forceRefresh: true })).toBeNull();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.bridge.refresh).not.toHaveBeenCalled();
      expect(await client.getAccessToken()).toBeNull();
      expect(client.getSnapshot()).toEqual({
        status: "error",
        code: "provider_unavailable",
        message: "Try again."
      });

      await expect(
        client.completeSignIn(
          "dev.orchestrat.app://auth/callback?code=retry&sb_flow_id=flow-a"
        )
      ).resolves.toMatchObject({ status: "success" });
      expect(await client.getAccessToken()).toBe("account-b");
      expect(
        (client.getSnapshot() as { identityKey: string }).identityKey
      ).not.toBe(identityA);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires the native session when refresh fails terminally", async () => {
    const f = fixture({ ...grant, expiresAtMs: 1_001 });
    f.bridge.refresh.mockRejectedValue({
      code: "provider_rejected",
      message: "Sign in again."
    });
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();

    expect(await client.getAccessToken()).toBeNull();
    expect(client.getSnapshot()).toEqual({ status: "signedOut" });
    expect(f.bridge.expire).toHaveBeenCalledOnce();
  });

  it("keeps an unexpired grant and identity while transient refresh retries back off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const f = fixture({ accessToken: "old-access", expiresAtMs: 20_000 });
      f.bridge.refresh
        .mockRejectedValueOnce({
          code: "provider_unavailable",
          message: "Try again."
        })
        .mockRejectedValueOnce({
          code: "provider_unavailable",
          message: "Try again."
        })
        .mockResolvedValueOnce({
          accessToken: "recovered",
          expiresAtMs: 80_000
        });
      const client = new DesktopAuthClient(f.platform, f.bridge, Date.now);
      await client.initialize();
      const identity = (client.getSnapshot() as { identityKey: string })
        .identityKey;

      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.bridge.refresh).toHaveBeenCalledTimes(1);
      expect(client.getSnapshot()).toEqual({
        status: "signedIn",
        identityKey: identity
      });
      expect(await client.getAccessToken({ forceRefresh: true })).toBeNull();
      expect(f.bridge.refresh).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(f.bridge.refresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.bridge.refresh).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(f.bridge.refresh).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.bridge.refresh).toHaveBeenCalledTimes(3);
      expect(await client.getAccessToken()).toBe("recovered");
      expect(client.getSnapshot()).toEqual({
        status: "signedIn",
        identityKey: identity
      });
      expect(f.bridge.expire).not.toHaveBeenCalled();
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns no expired token during transient cooldown and later recovers the same identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const f = fixture({ accessToken: "old-access", expiresAtMs: 2_500 });
      f.bridge.refresh
        .mockRejectedValueOnce({
          code: "provider_unavailable",
          message: "Try again."
        })
        .mockResolvedValueOnce({
          accessToken: "recovered",
          expiresAtMs: 80_000
        });
      const client = new DesktopAuthClient(f.platform, f.bridge, Date.now);
      await client.initialize();
      const identity = (client.getSnapshot() as { identityKey: string })
        .identityKey;

      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.bridge.refresh).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(500);
      expect(await client.getAccessToken()).toBeNull();
      expect(f.bridge.refresh).toHaveBeenCalledOnce();
      expect(client.getSnapshot()).toEqual({
        status: "error",
        code: "provider_unavailable",
        message: "Try again."
      });
      expect(f.bridge.expire).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      expect(f.bridge.refresh).toHaveBeenCalledTimes(2);
      expect(await client.getAccessToken()).toBe("recovered");
      expect(client.getSnapshot()).toEqual({
        status: "signedIn",
        identityKey: identity
      });
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes restore failures recoverable errors", async () => {
    const f = fixture();
    f.bridge.restore.mockRejectedValue({
      code: "restore_failed",
      message: "Try again."
    });
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);

    await client.initialize();
    expect(client.getSnapshot()).toEqual({
      status: "error",
      code: "restore_failed",
      message: "Try again."
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

    callback?.(
      new URL("dev.orchestrat.app://auth/callback?code=a&sb_flow_id=b")
    );
    await vi.waitFor(() =>
      expect(client.getSnapshot()).toMatchObject({ status: "signedIn" })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    callback?.(
      new URL("dev.orchestrat.app://auth/callback?code=a&sb_flow_id=b")
    );
    await Promise.resolve();
    expect(f.bridge.complete).toHaveBeenCalledOnce();
  });

  it("accepts a new GitHub callback after a local sign-out", async () => {
    const f = fixture();
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    await client.signOut();
    await client.signInWithGitHub();
    f.getCallback()?.(
      new URL("dev.orchestrat.app://auth/callback?code=new&sb_flow_id=fresh")
    );
    await vi.waitFor(() =>
      expect(client.getSnapshot()).toMatchObject({ status: "signedIn" })
    );
    expect(f.bridge.complete).toHaveBeenCalledOnce();
  });

  it("ignores callbacks after disposal", async () => {
    const f = fixture();
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    const callback = f.getCallback();

    client.dispose();
    callback?.(
      new URL("dev.orchestrat.app://auth/callback?code=a&sb_flow_id=b")
    );
    await Promise.resolve();

    expect(f.bridge.complete).not.toHaveBeenCalled();
  });

  it("unlistens when a callback subscription resolves after disposal", async () => {
    let resolveSubscription: ((unlisten: () => void) => void) | undefined;
    const unlisten = vi.fn();
    const f = fixture();
    f.platform.onAuthCallback.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubscription = resolve;
        })
    );
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
    expect(client.getSnapshot()).toEqual({
      status: "sendingMagicLink",
      email: "person@example.com"
    });
    expect(f.bridge.sendMagicLink).toHaveBeenCalledWith("person@example.com");
    sending.resolve(undefined);
    await first;
    expect(client.getSnapshot()).toEqual({
      status: "magicLinkSent",
      email: "person@example.com"
    });
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off repeated short-lived proactive grants and refreshes expired grants on demand", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const f = fixture({ accessToken: "short-0", expiresAtMs: 2_000 });
      let sequence = 0;
      f.bridge.refresh.mockImplementation(async () => ({
        accessToken: `short-${++sequence}`,
        expiresAtMs: Date.now() + 5_000
      }));
      const client = new DesktopAuthClient(f.platform, f.bridge, Date.now);
      await client.initialize();

      await vi.advanceTimersByTimeAsync(999);
      expect(f.bridge.refresh).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.bridge.refresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(f.bridge.refresh).toHaveBeenCalledTimes(5);

      const expired = fixture({
        accessToken: "expired",
        expiresAtMs: Date.now() - 1
      });
      expired.bridge.refresh.mockResolvedValue({
        accessToken: "recovered",
        expiresAtMs: Date.now() + 60_000
      });
      const expiredClient = new DesktopAuthClient(
        expired.platform,
        expired.bridge,
        Date.now
      );
      await expiredClient.initialize();
      expect(await expiredClient.getAccessToken()).toBe("recovered");
      expect(expired.bridge.refresh).toHaveBeenCalledOnce();
      client.dispose();
      expiredClient.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps exchange lock when a transient distinct callback settles before a mismatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const f = fixture({ accessToken: "account-a", expiresAtMs: 61_000 });
      const uncertain = deferred<typeof grant>();
      const mismatch = deferred<typeof grant>();
      f.bridge.complete.mockImplementation((callback) =>
        callback.includes("sb_flow_id=uncertain")
          ? uncertain.promise
          : mismatch.promise
      );
      const client = new DesktopAuthClient(f.platform, f.bridge, Date.now);
      await client.initialize();
      const first = client.completeSignIn(
        "dev.orchestrat.app://auth/callback?code=a&sb_flow_id=uncertain"
      );
      const second = client.completeSignIn(
        "dev.orchestrat.app://auth/callback?code=b&sb_flow_id=mismatch"
      );
      uncertain.reject({ code: "provider_unavailable", message: "Try again." });
      await expect(first).resolves.toEqual({ status: "error" });
      mismatch.reject({ code: "flow_mismatch", message: "Wrong flow." });
      await expect(second).resolves.toEqual({ status: "error" });

      expect(await client.getAccessToken({ forceRefresh: true })).toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.bridge.refresh).not.toHaveBeenCalled();
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches distinct in-flight flows, coalesces an identical flow, and lets the valid flow win", async () => {
    const f = fixture();
    const wrong = deferred<typeof grant>();
    const valid = deferred<typeof grant>();
    f.bridge.complete.mockImplementation((callback) =>
      callback.includes("sb_flow_id=wrong") ? wrong.promise : valid.promise
    );
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();

    const wrongResult = client.completeSignIn(
      "dev.orchestrat.app://auth/callback?code=wrong-code&sb_flow_id=wrong"
    );
    const validUrl =
      "dev.orchestrat.app://auth/callback?code=valid-code&sb_flow_id=valid";
    const validResult = client.completeSignIn(validUrl);
    const duplicate = client.completeSignIn(validUrl);
    expect(duplicate).toBe(validResult);
    expect(f.bridge.complete).toHaveBeenCalledTimes(2);

    wrong.reject({
      code: "flow_mismatch",
      message: "The callback flow does not match."
    });
    expect(await wrongResult).toEqual({ status: "error" });
    expect(client.getSnapshot()).toEqual({ status: "signingIn" });
    valid.resolve({ accessToken: "valid-access", expiresAtMs: 60_000 });
    await expect(validResult).resolves.toMatchObject({ status: "success" });
    expect(await client.getAccessToken()).toBe("valid-access");
  });

  it("uses the strict shared email grammar before creating native pending state", async () => {
    const f = fixture();
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    for (const invalid of [
      "a@.com",
      "a@b..com",
      ".a@example.com",
      "a.@example.com",
      "a..b@example.com",
      "a@example",
      "a@-example.com",
      "a@example-.com",
      "a b@example.com",
      "a@éxample.com",
      "K@example.com",
      `${"a".repeat(65)}@example.com`,
      `a@${"b".repeat(64)}.com`
    ])
      await client.sendMagicLink(invalid);
    expect(f.bridge.sendMagicLink).not.toHaveBeenCalled();

    await client.sendMagicLink("  User.Name+tag@Sub.Example.COM  ");
    expect(f.bridge.sendMagicLink).toHaveBeenCalledWith(
      "user.name+tag@sub.example.com"
    );
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
    } finally {
      vi.useRealTimers();
    }
  });
});
