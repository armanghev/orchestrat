import { describe, expect, it, vi } from "vitest";
import { DesktopAuthClient } from "./desktop-auth-client";

const grant = { accessToken: "access-1", expiresAtMs: 60_000 };

function fixture(restored: typeof grant | null = null) {
  let callback: ((url: URL) => void) | undefined;
  const bridge = {
    begin: vi.fn(async () => undefined),
    complete: vi.fn(async () => grant),
    refresh: vi.fn(async () => ({ ...grant, accessToken: "access-2" })),
    restore: vi.fn(async () => restored),
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

    expect(client.capabilities).toEqual({ github: true, magicLink: false });
    await client.signInWithGitHub();
    expect(client.getSnapshot()).toEqual({ status: "signingIn" });
    expect(f.bridge.begin).toHaveBeenCalledOnce();
    expect(f.platform.openExternal).not.toHaveBeenCalled();

    await client.completeSignIn(
      "dev.orchestrat.app://auth/callback?code=a&state=b"
    );
    expect(client.getSnapshot()).toEqual({ status: "signedIn" });
    expect(await client.getAccessToken()).toBe("access-1");
    expect(await client.getAccessToken({ forceRefresh: true })).toBe("access-2");

    await client.signOut();
    expect(client.getSnapshot()).toEqual({ status: "signedOut" });
    expect(await client.getAccessToken()).toBeNull();
  });

  it("converts rejected callbacks into stable errors", async () => {
    const f = fixture();
    f.bridge.complete.mockRejectedValue({
      code: "state_mismatch",
      message: "The callback state does not match."
    });
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    await client.completeSignIn(
      "dev.orchestrat.app://auth/callback?code=a&state=wrong"
    );
    expect(client.getSnapshot()).toEqual({
      status: "error",
      code: "state_mismatch",
      message: "The callback state does not match."
    });
  });

  it("refreshes automatically when fewer than 30 seconds remain", async () => {
    const f = fixture({ ...grant, expiresAtMs: 30_999 });
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();

    expect(await client.getAccessToken()).toBe("access-2");
    expect(f.bridge.refresh).toHaveBeenCalledOnce();
  });

  it("expires the session when refresh fails", async () => {
    const f = fixture({ ...grant, expiresAtMs: 1_001 });
    f.bridge.refresh.mockRejectedValue(new Error("offline"));
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();

    expect(await client.getAccessToken()).toBeNull();
    expect(client.getSnapshot()).toEqual({ status: "signedOut" });
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
    expect(f.bridge.begin).toHaveBeenCalledOnce();
  });

  it("completes each subscribed deep link once", async () => {
    const f = fixture();
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    const callback = f.getCallback();
    expect(callback).toBeDefined();

    callback?.(new URL("dev.orchestrat.app://auth/callback?code=a&state=b"));
    await vi.waitFor(() => expect(client.getSnapshot()).toEqual({ status: "signedIn" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    callback?.(new URL("dev.orchestrat.app://auth/callback?code=a&state=b"));
    await Promise.resolve();
    expect(f.bridge.complete).toHaveBeenCalledOnce();
  });


  it("accepts a new GitHub callback after a local sign-out", async () => {
    const f = fixture();
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    await client.signOut();
    await client.signInWithGitHub();
    f.getCallback()?.(new URL("dev.orchestrat.app://auth/callback?code=new&state=fresh"));
    await vi.waitFor(() => expect(client.getSnapshot()).toEqual({ status: "signedIn" }));
    expect(f.bridge.complete).toHaveBeenCalledOnce();
  });

  it("ignores callbacks after disposal", async () => {
    const f = fixture();
    const client = new DesktopAuthClient(f.platform, f.bridge, () => 1_000);
    await client.initialize();
    const callback = f.getCallback();

    client.dispose();
    callback?.(new URL("dev.orchestrat.app://auth/callback?code=a&state=b"));
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

});
