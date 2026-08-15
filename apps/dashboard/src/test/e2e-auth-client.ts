import type { AuthClient, AuthSnapshot } from "../features/auth/auth-client";

const storageKey = "orchestrat.e2e.auth";

export class E2eAuthClient implements AuthClient {
  readonly capabilities = { github: true, magicLink: true };
  private snapshot: AuthSnapshot = { status: "loading" };
  private readonly listeners = new Set<() => void>();

  constructor() {
    if (import.meta.env.MODE !== "e2e") throw new Error("E2E authentication is only available in e2e mode.");
  }

  async initialize(): Promise<void> {
    this.setSnapshot({ status: localStorage.getItem(storageKey) === "signedOut" ? "signedOut" : "signedIn" });
  }
  getSnapshot(): AuthSnapshot { return this.snapshot; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async signInWithGitHub(): Promise<void> { localStorage.setItem(storageKey, "signedIn"); this.setSnapshot({ status: "signedIn" }); }
  async sendMagicLink(email: string): Promise<void> { this.setSnapshot({ status: "magicLinkSent", email: email.trim().toLowerCase() }); }
  async completeSignIn(): Promise<void> { this.setSnapshot({ status: "signedIn" }); }
  async signOut(): Promise<void> { localStorage.setItem(storageKey, "signedOut"); this.setSnapshot({ status: "signedOut" }); }
  async expireSession(): Promise<void> { this.setSnapshot({ status: "signedOut" }); }
  async getAccessToken(): Promise<string | null> { return this.snapshot.status === "signedIn" ? "e2e-session-token" : null; }

  private setSnapshot(snapshot: AuthSnapshot): void {
    if (this.snapshot.status === snapshot.status) return;
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}
