import type { AuthClient, AuthSnapshot } from "../features/auth/auth-client";

export class E2eAuthClient implements AuthClient {
  private snapshot: AuthSnapshot = { status: "loading" };
  private readonly listeners = new Set<() => void>();

  async initialize(): Promise<void> { this.setSnapshot({ status: "signedIn" }); }
  getSnapshot(): AuthSnapshot { return this.snapshot; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async signIn(): Promise<void> { this.setSnapshot({ status: "signedIn" }); }
  async completeSignIn(): Promise<void> { this.setSnapshot({ status: "signedIn" }); }
  async signOut(): Promise<void> { this.setSnapshot({ status: "signedOut" }); }
  async expireSession(): Promise<void> { this.setSnapshot({ status: "signedOut" }); }
  async getAccessToken(): Promise<string | null> { return this.snapshot.status === "signedIn" ? "e2e-session-token" : null; }

  private setSnapshot(snapshot: AuthSnapshot): void {
    if (this.snapshot.status === snapshot.status) return;
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}
