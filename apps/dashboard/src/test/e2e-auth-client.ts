import type {
  AuthClient,
  AuthSnapshot,
  TokenOptions
} from "../features/auth/auth-client";
import { normalizeAuthEmail } from "../features/auth/email";

const storageKey = "orchestrat.e2e.auth";
const refreshCountKey = "orchestrat.e2e.refreshes";
const magicPrefix = "magic:";

export class E2eAuthClient implements AuthClient {
  readonly capabilities = { github: true, magicLink: true };
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
    if (stored === "signedOut") this.setSnapshot({ status: "signedOut" });
    else if (stored?.startsWith(magicPrefix)) {
      const email = normalizeAuthEmail(stored.slice(magicPrefix.length));
      this.setSnapshot(
        email ? { status: "magicLinkSent", email } : { status: "signedOut" }
      );
    } else if (stored === null || stored === "signedIn") {
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
  async signInWithGitHub(): Promise<void> {
    localStorage.setItem(storageKey, "signedIn");
    this.refreshed = false;
    this.setSnapshot({ status: "signedIn", identityKey: this.nextIdentity() });
  }
  async sendMagicLink(value: string): Promise<void> {
    const email = normalizeAuthEmail(value);
    if (!email) {
      this.setSnapshot({
        status: "error",
        code: "invalid_email",
        message: "Enter a valid email address."
      });
      return;
    }
    localStorage.setItem(storageKey, `${magicPrefix}${email}`);
    this.setSnapshot({ status: "magicLinkSent", email });
  }
  async completeSignIn(callbackUrl: string) {
    let valid = this.snapshot.status === "magicLinkSent";
    try {
      const url = new URL(callbackUrl);
      valid &&=
        url.origin === window.location.origin &&
        url.pathname === "/auth/callback" &&
        url.searchParams.size === 1 &&
        url.searchParams.get("code") === "e2e-magic-code";
    } catch {
      valid = false;
    }
    if (!valid) {
      this.setSnapshot({
        status: "error",
        code: "invalid_callback",
        message: "The callback is invalid."
      });
      return { status: "error" as const };
    }
    localStorage.setItem(storageKey, "signedIn");
    const identityKey = this.nextIdentity();
    this.setSnapshot({ status: "signedIn", identityKey });
    return { status: "success" as const, identityKey };
  }
  async signOut(): Promise<void> {
    localStorage.setItem(storageKey, "signedOut");
    this.refreshed = false;
    this.setSnapshot({ status: "signedOut" });
  }
  async expireSession(): Promise<void> {
    localStorage.setItem(storageKey, "signedOut");
    this.refreshed = false;
    this.setSnapshot({ status: "signedOut" });
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

  private setSnapshot(snapshot: AuthSnapshot): void {
    if (JSON.stringify(this.snapshot) === JSON.stringify(snapshot)) return;
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}
