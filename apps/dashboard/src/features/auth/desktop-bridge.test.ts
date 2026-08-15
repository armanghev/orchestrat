import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopAuthBridge } from "./desktop-bridge";

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => core);

describe("desktopAuthBridge", () => {
  beforeEach(() => { vi.clearAllMocks(); core.invoke.mockResolvedValue(undefined); });

  it("uses only provider-neutral native commands and exact public arguments", async () => {
    await desktopAuthBridge.beginGitHub();
    await desktopAuthBridge.sendMagicLink("person@example.com");
    await desktopAuthBridge.restore();
    await desktopAuthBridge.complete("dev.orchestrat.app://auth/callback?code=c&sb_flow_id=f");
    await desktopAuthBridge.refresh();
    await desktopAuthBridge.expire();
    await desktopAuthBridge.signOut();
    expect(core.invoke.mock.calls).toEqual([
      ["auth_begin_github"],
      ["auth_send_magic_link", { email: "person@example.com" }],
      ["auth_restore"],
      ["auth_complete", { callbackUrl: "dev.orchestrat.app://auth/callback?code=c&sb_flow_id=f" }],
      ["auth_refresh"],
      ["auth_expire"],
      ["auth_sign_out"]
    ]);
  });
});
