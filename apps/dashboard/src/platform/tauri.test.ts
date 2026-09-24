import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTauriPlatform } from "./tauri";

const mocks = vi.hoisted(() => ({
  deepLink: { getCurrent: vi.fn(), onOpenUrl: vi.fn() },
  event: { listen: vi.fn() },
  notification: {
    isPermissionGranted: vi.fn(),
    requestPermission: vi.fn()
  },
  invoke: vi.fn()
}));

vi.mock("@tauri-apps/plugin-deep-link", () => mocks.deepLink);
vi.mock("@tauri-apps/api/event", () => mocks.event);
vi.mock("@tauri-apps/plugin-notification", () => mocks.notification);
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

describe("Tauri auth callbacks", () => {
  const callback = "dev.orchestrat.app://auth/callback?code=abc";
  let unlisten: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    unlisten = vi.fn();
    mocks.deepLink.getCurrent.mockResolvedValue(null);
    mocks.deepLink.onOpenUrl.mockResolvedValue(unlisten);
  });

  it("receives a warm callback delivered while cold-start URLs are loading", async () => {
    let resolveCurrent: (urls: string[] | null) => void = () => undefined;
    mocks.deepLink.getCurrent.mockImplementation(
      () =>
        new Promise<string[] | null>((resolve) => (resolveCurrent = resolve))
    );
    let listener: ((urls: string[]) => void) | undefined;
    mocks.deepLink.onOpenUrl.mockImplementation(async (callbackListener) => {
      listener = callbackListener;
      return unlisten;
    });
    const received: string[] = [];
    const pending = createTauriPlatform().onAuthCallback((url) =>
      received.push(url.toString())
    );
    await vi.waitFor(() =>
      expect(mocks.deepLink.onOpenUrl).toHaveBeenCalledOnce()
    );
    listener?.([callback]);
    resolveCurrent([callback]);
    const unsubscribe = await pending;
    expect(received).toEqual([callback]);
    unsubscribe();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("drops malformed encodings but delivers distinct valid flow callbacks from one warm batch", async () => {
    let listener: ((urls: string[]) => void) | undefined;
    mocks.deepLink.onOpenUrl.mockImplementation(async (callbackListener) => {
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
    mocks.deepLink.getCurrent.mockRejectedValue(error);
    await expect(createTauriPlatform().onAuthCallback(vi.fn())).rejects.toThrow(
      error
    );
    expect(mocks.deepLink.onOpenUrl).toHaveBeenCalledOnce();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

describe("Tauri notifications", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const taskId = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notification.isPermissionGranted.mockResolvedValue(true);
    mocks.notification.requestPermission.mockResolvedValue("granted");
  });

  it("invokes the native response-aware notification command", async () => {
    const notification = {
      title: "Task completed",
      body: "Ship it",
      destination: { kind: "task" as const, projectId, taskId }
    };
    await createTauriPlatform().notify?.(notification);
    expect(mocks.invoke).toHaveBeenCalledWith("show_native_notification", {
      notification
    });
  });

  it("does not invoke native delivery when permission is denied", async () => {
    mocks.notification.isPermissionGranted.mockResolvedValue(false);
    mocks.notification.requestPermission.mockResolvedValue("denied");
    await createTauriPlatform().notify?.({
      title: "Agent run failed",
      body: "An agent run failed.",
      destination: { kind: "activity", projectId }
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("delivers only validated typed native click destinations", async () => {
    let listener: ((event: { payload: unknown }) => void) | undefined;
    const unlisten = vi.fn();
    mocks.event.listen.mockImplementation(async (_name, callback) => {
      listener = callback;
      return unlisten;
    });
    const received = vi.fn();
    const stop = await createTauriPlatform().onNotificationAction?.(received);
    expect(mocks.event.listen).toHaveBeenCalledWith(
      "notification-action",
      expect.any(Function)
    );
    listener?.({ payload: { kind: "task", projectId, taskId } });
    listener?.({
      payload: { kind: "task", projectId, taskId: "../../settings" }
    });
    listener?.({ payload: { kind: "url", url: "https://example.com" } });
    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith({ kind: "task", projectId, taskId });
    stop?.();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

describe("Tauri local integration status", () => {
  it("invokes the safe native command with the project id", async () => {
    mocks.invoke.mockResolvedValue({
      supported: true,
      cli_exists: true,
      project_mapping: true,
      integrations: {}
    });
    await createTauriPlatform().localIntegrationStatus?.("project-1");
    expect(mocks.invoke).toHaveBeenCalledWith("local_integration_status", {
      projectId: "project-1"
    });
  });
});
