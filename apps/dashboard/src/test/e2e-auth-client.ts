import type { AuthClient, AuthSnapshot } from "../features/auth/auth-client";

const storageKey = "orchestrat.e2e.auth";

export class E2eAuthClient implements AuthClient {
  readonly capabilities = { github: true, magicLink: true };
  private snapshot: AuthSnapshot = { status: "loading" };
  private readonly listeners = new Set<() => void>();
  private identitySequence = 0;
  private initialized = false;

  private nextIdentity(): string { return `e2e-session-${++this.identitySequence}`; }

  constructor() {
    if (import.meta.env.MODE !== "e2e") throw new Error("E2E authentication is only available in e2e mode.");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.setSnapshot(localStorage.getItem(storageKey) === "signedOut"
      ? { status: "signedOut" }
      : { status: "signedIn", identityKey: this.nextIdentity() });
  }
  getSnapshot(): AuthSnapshot { return this.snapshot; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async signInWithGitHub(): Promise<void> { localStorage.setItem(storageKey, "signedIn"); this.setSnapshot({ status: "signedIn", identityKey: this.nextIdentity() }); }
  async sendMagicLink(email: string): Promise<void> { this.setSnapshot({ status: "magicLinkSent", email: email.trim().toLowerCase() }); }
  async completeSignIn() { const identityKey = this.nextIdentity(); this.setSnapshot({ status: "signedIn", identityKey }); return { status: "success" as const, identityKey }; }
  async signOut(): Promise<void> { localStorage.setItem(storageKey, "signedOut"); this.setSnapshot({ status: "signedOut" }); }
  async expireSession(): Promise<void> { this.setSnapshot({ status: "signedOut" }); }
  async getAccessToken(): Promise<string | null> { return this.snapshot.status === "signedIn" ? "e2e-session-token" : null; }

  private setSnapshot(snapshot: AuthSnapshot): void {
    if (this.snapshot.status === snapshot.status &&
        (snapshot.status !== "signedIn" || this.snapshot.status !== "signedIn" || snapshot.identityKey === this.snapshot.identityKey)) return;
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}
