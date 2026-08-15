import type { AccessGrant } from "./auth-client";

export interface DesktopAuthBridge {
  beginGitHub(): Promise<void>;
  sendMagicLink(email: string): Promise<void>;
  restore(): Promise<AccessGrant | null>;
  complete(callbackUrl: string): Promise<AccessGrant>;
  refresh(): Promise<AccessGrant>;
  expire(): Promise<void>;
  signOut(): Promise<void>;
}

async function invoke<T>(command: string, arguments_?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return arguments_ === undefined ? tauriInvoke<T>(command) : tauriInvoke<T>(command, arguments_);
}

export const desktopAuthBridge: DesktopAuthBridge = {
  beginGitHub: () => invoke("auth_begin_github"),
  sendMagicLink: (email) => invoke("auth_send_magic_link", { email }),
  restore: () => invoke<AccessGrant | null>("auth_restore"),
  complete: (callbackUrl) => invoke<AccessGrant>("auth_complete", { callbackUrl }),
  refresh: () => invoke<AccessGrant>("auth_refresh"),
  expire: () => invoke("auth_expire"),
  signOut: () => invoke("auth_sign_out")
};
