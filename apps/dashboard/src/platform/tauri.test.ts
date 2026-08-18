import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTauriPlatform } from "./tauri";

const deepLink = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  onOpenUrl: vi.fn()
}));

vi.mock("@tauri-apps/plugin-deep-link", () => deepLink);

describe("Tauri auth callbacks", () => {
  const callback = "dev.orchestrat.app://auth/callback?code=abc&sb_flow_id=xyz";
  let unlisten: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    unlisten = vi.fn();
    deepLink.getCurrent.mockResolvedValue(null);
    deepLink.onOpenUrl.mockResolvedValue(unlisten);
  });

  it("receives a warm callback delivered while cold-start URLs are loading", async () => {
    let resolveCurrent: (urls: string[] | null) => void = () => undefined;
    deepLink.getCurrent.mockImplementation(
      () =>
        new Promise<string[] | null>((resolve) => (resolveCurrent = resolve))
    );
    let listener: ((urls: string[]) => void) | undefined;
    deepLink.onOpenUrl.mockImplementation(async (callbackListener) => {
      listener = callbackListener;
      return unlisten;
    });
    const received: string[] = [];

    const pending = createTauriPlatform().onAuthCallback((url) => {
      received.push(url.toString());
    });
    await vi.waitFor(() => expect(deepLink.onOpenUrl).toHaveBeenCalledOnce());
    listener?.([callback]);
    resolveCurrent([callback]);

    const unsubscribe = await pending;
    expect(received).toEqual([callback]);
    unsubscribe();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("drops malformed encodings but delivers distinct valid flow callbacks from one warm batch", async () => {
    let listener: ((urls: string[]) => void) | undefined;
    deepLink.onOpenUrl.mockImplementation(async (callbackListener) => {
      listener = callbackListener;
      return unlisten;
    });
    const received: string[] = [];
    await createTauriPlatform().onAuthCallback((url) =>
      received.push(url.toString())
    );
    listener?.([
      "dev.orchestrat.app://auth/callback?code=%FF&sb_flow_id=valid",
      "dev.orchestrat.app://auth/callback?code=wrong&sb_flow_id=wrong",
      "dev.orchestrat.app://auth/callback?code=valid&sb_flow_id=valid",
      "dev.orchestrat.app://auth/callback?code=different-secret&sb_flow_id=valid"
    ]);
    expect(received).toEqual([
      "dev.orchestrat.app://auth/callback?code=wrong&sb_flow_id=wrong",
      "dev.orchestrat.app://auth/callback?code=valid&sb_flow_id=valid"
    ]);
  });

  it("unlistens if loading cold-start URLs fails after subscribing", async () => {
    const error = new Error("cold-start failed");
    deepLink.getCurrent.mockRejectedValue(error);

    await expect(createTauriPlatform().onAuthCallback(vi.fn())).rejects.toThrow(
      error
    );
    expect(deepLink.onOpenUrl).toHaveBeenCalledOnce();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
