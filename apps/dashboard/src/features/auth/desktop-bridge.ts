import type { AccessGrant } from "./auth-client";

export interface DesktopAuthBridge {
  begin(): Promise<void>;
  restore(): Promise<AccessGrant | null>;
  complete(callbackUrl: string): Promise<AccessGrant>;
  refresh(): Promise<AccessGrant>;
  signOut(): Promise<void>;
}

export const desktopAuthBridge: DesktopAuthBridge = {
  async begin() {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("oauth_begin");
  },
  async restore() {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<AccessGrant | null>("oauth_restore");
  },
  async complete(callbackUrl) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<AccessGrant>("oauth_complete", { callbackUrl });
  },
  async refresh() {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<AccessGrant>("oauth_refresh");
  },
  async signOut() {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("oauth_sign_out");
  }
};
