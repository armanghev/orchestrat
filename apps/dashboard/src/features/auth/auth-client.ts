// identityKey exists only to partition UI cache lifecycle; it must never be used for authorization.
export type AuthSnapshot =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "signingIn" }
  | { status: "sendingMagicLink"; email: string }
  | { status: "magicLinkSent"; email: string }
  | { status: "signedIn"; identityKey: string }
  | { status: "error"; code: string; message: string };

export type AuthCapabilities = {
  github: boolean;
  magicLink: boolean;
  browserPortal?: boolean;
};
export type AuthCompletionResult =
  { status: "success"; identityKey: string } | { status: "error" };
export type TokenOptions = { forceRefresh?: boolean };

export interface AuthClient {
  readonly capabilities: AuthCapabilities;
  initialize(): Promise<void>;
  getSnapshot(): AuthSnapshot;
  subscribe(listener: () => void): () => void;
  signInWithGitHub(): Promise<void>;
  sendMagicLink(email: string): Promise<void>;
  completeSignIn(callbackUrl: string): Promise<AuthCompletionResult>;
  signOut(): Promise<void>;
  expireSession(): Promise<void>;
  getAccessToken(options?: TokenOptions): Promise<string | null>;
}

export type AccessGrant = { accessToken: string; expiresAtMs: number };

export const loadingAuthSnapshot: AuthSnapshot = { status: "loading" };
export const noAuthCapabilities: AuthCapabilities = Object.freeze({
  github: false,
  magicLink: false
});

export const loadingAuthClient: AuthClient = {
  capabilities: noAuthCapabilities,
  async initialize() {},
  getSnapshot: () => loadingAuthSnapshot,
  subscribe: () => () => undefined,
  async signInWithGitHub() {},
  async sendMagicLink() {},
  async completeSignIn() {
    return { status: "error" } as const;
  },
  async signOut() {},
  async expireSession() {},
  async getAccessToken() {
    return null;
  }
};
