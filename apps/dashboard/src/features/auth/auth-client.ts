export type AuthSnapshot =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "signingIn" }
  | { status: "signedIn" }
  | { status: "error"; code: string; message: string };

export type TokenOptions = { forceRefresh?: boolean };

export interface AuthClient {
  initialize(): Promise<void>;
  getSnapshot(): AuthSnapshot;
  subscribe(listener: () => void): () => void;
  signIn(): Promise<void>;
  completeSignIn(callbackUrl: string): Promise<void>;
  signOut(): Promise<void>;
  expireSession(): Promise<void>;
  getAccessToken(options?: TokenOptions): Promise<string | null>;
}

export type AccessGrant = { accessToken: string; expiresAtMs: number };

export const loadingAuthSnapshot: AuthSnapshot = { status: "loading" };

export const loadingAuthClient: AuthClient = {
  async initialize() {},
  getSnapshot: () => loadingAuthSnapshot,
  subscribe: () => () => undefined,
  async signIn() {},
  async completeSignIn() {},
  async signOut() {},
  async expireSession() {},
  async getAccessToken() {
    return null;
  }
};
