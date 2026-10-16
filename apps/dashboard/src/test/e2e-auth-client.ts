import {
  AuthRequestError,
  type AuthClient,
  type AuthInstance,
  type AuthSnapshot,
  type SignUpInput,
  type SignUpResult,
  type TokenOptions
} from "../features/auth/auth-client";
import { normalizeAuthEmail } from "../features/auth/email";

const storageKey = "orchestrat.e2e.auth";
const refreshCountKey = "orchestrat.e2e.refreshes";
// The stub rejects this password so specs can show the inline error.
const wrongPassword = "wrong-password";

// A stand-in for the password client. Specs that need the real client and
// its HTTP calls set `orchestrat.e2e.auth` to "password" instead.
export class E2eAuthClient implements AuthClient {
  private snapshot: AuthSnapshot = { status: "loading" };
  private readonly listeners = new Set<() => void>();
  private identitySequence = 0;
  private initialized = false;
  private refreshed = false;

  private nextIdentity(): string {
    return `e2e-session-${++this.identitySequence}`;
  }

  constructor() {
    // This module is dynamically loaded only by the explicit e2e build. No URL/query-controlled mode exists.
    if (import.meta.env.MODE !== "e2e")
      throw new Error("E2E authentication is only available in e2e mode.");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const stored = localStorage.getItem(storageKey);
    if (stored === null || stored === "signedIn") {
      this.setSnapshot({
        status: "signedIn",
        identityKey: this.nextIdentity()
      });
    } else this.setSnapshot({ status: "signedOut" });
  }
  getSnapshot(): AuthSnapshot {
    return this.snapshot;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async getInstance(): Promise<AuthInstance> {
    return { needs_setup: false, signup_mode: "invite" };
  }
  async signIn(email: string, password: string): Promise<void> {
    if (!normalizeAuthEmail(email) || password === wrongPassword)
      throw new AuthRequestError(
        "Email or password is incorrect.",
        "INVALID_CREDENTIALS",
        401
      );
    this.startSession();
  }
  async signUp(input: SignUpInput): Promise<SignUpResult> {
    if (!normalizeAuthEmail(input.email))
      throw new AuthRequestError(
        "The request is invalid.",
        "VALIDATION_ERROR",
        400
      );
    this.startSession();
    return { invitedProjectId: null };
  }
  async signOut(): Promise<void> {
    this.endSession();
  }
  async signOutEverywhere(): Promise<void> {
    this.endSession();
  }
  async changePassword(current: string): Promise<void> {
    if (current === wrongPassword)
      throw new AuthRequestError(
        "The current password is incorrect.",
        "PASSWORD_INCORRECT",
        403
      );
  }
  async expireSession(): Promise<void> {
    this.endSession();
  }
  async getAccessToken(options: TokenOptions = {}): Promise<string | null> {
    if (this.snapshot.status !== "signedIn") return null;
    if (options.forceRefresh) {
      const count = Number(localStorage.getItem(refreshCountKey) ?? "0");
      localStorage.setItem(
        refreshCountKey,
        String(Number.isSafeInteger(count) ? count + 1 : 1)
      );
      this.refreshed = true;
    }
    return this.refreshed ? "e2e-refreshed-token" : "e2e-session-token";
  }

  private startSession(): void {
    localStorage.setItem(storageKey, "signedIn");
    this.refreshed = false;
    this.setSnapshot({ status: "signedIn", identityKey: this.nextIdentity() });
  }

  private endSession(): void {
    localStorage.setItem(storageKey, "signedOut");
    this.refreshed = false;
    this.setSnapshot({ status: "signedOut" });
  }

  private setSnapshot(snapshot: AuthSnapshot): void {
    if (JSON.stringify(this.snapshot) === JSON.stringify(snapshot)) return;
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}
