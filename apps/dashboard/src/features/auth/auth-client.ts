import type { AuthInstanceResponse } from "@orchestrat/protocol";

// identityKey exists only to partition UI cache lifecycle; it must never be used for authorization.
export type AuthSnapshot =
  | { status: "loading" }
  | { status: "signedOut" }
  | { status: "signedIn"; identityKey: string };

export type AuthInstance = AuthInstanceResponse;
export type TokenOptions = { forceRefresh?: boolean };
export type SignUpInput = {
  email: string;
  password: string;
  fullName: string;
  inviteToken?: string;
  /** Required for the first account; the server prints it in its log. */
  setupToken?: string;
};
/** An invite signup joins the project in the same request. */
export type SignUpResult = { invitedProjectId: string | null };

// Codes come from the API (INVALID_CREDENTIALS, RATE_LIMITED, ...) or from
// the client itself (NETWORK_ERROR, INVALID_RESPONSE, UNAUTHENTICATED).
export class AuthRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "AuthRequestError";
  }
}

export interface AuthClient {
  initialize(): Promise<void>;
  getSnapshot(): AuthSnapshot;
  subscribe(listener: () => void): () => void;
  /** Whether this server still needs its first account, and who may sign up. */
  getInstance(options?: { refresh?: boolean }): Promise<AuthInstance>;
  signIn(email: string, password: string): Promise<void>;
  signUp(input: SignUpInput): Promise<SignUpResult>;
  /** Ends this session on the server and forgets it locally. */
  signOut(): Promise<void>;
  /** Ends every session for this account, including this one. */
  signOutEverywhere(): Promise<void>;
  /** Keeps this session and ends the others. */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  /** Forgets the local session after the API rejected it. */
  expireSession(): Promise<void>;
  getAccessToken(options?: TokenOptions): Promise<string | null>;
}

export const loadingAuthSnapshot: AuthSnapshot = { status: "loading" };

const unavailable = () =>
  Promise.reject(
    new AuthRequestError(
      "Authentication is still loading.",
      "UNAUTHENTICATED",
      null
    )
  );

export const loadingAuthClient: AuthClient = {
  async initialize() {},
  getSnapshot: () => loadingAuthSnapshot,
  subscribe: () => () => undefined,
  getInstance: unavailable,
  signIn: unavailable,
  signUp: unavailable,
  async signOut() {},
  async signOutEverywhere() {},
  changePassword: unavailable,
  async expireSession() {},
  async getAccessToken() {
    return null;
  }
};
