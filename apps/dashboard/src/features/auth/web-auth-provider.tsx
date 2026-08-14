import { ClerkProvider, useAuth, useClerk } from "@clerk/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { loadingAuthClient, type AuthClient, type AuthSnapshot, type TokenOptions } from "./auth-client";
import { AuthContext } from "./auth-context";

class ClerkAuthClient implements AuthClient {
  private snapshot: AuthSnapshot = { status: "loading" };
  private readonly listeners = new Set<() => void>();
  private openSignIn: (() => void) | null = null;
  private signOutWithClerk: (() => Promise<void>) | null = null;
  private getTokenWithClerk: ((options: { skipCache: boolean }) => Promise<string | null>) | null = null;

  update(isLoaded: boolean, isSignedIn: boolean | undefined, openSignIn: () => void, signOut: () => Promise<void>, getToken: (options: { skipCache: boolean }) => Promise<string | null>): void {
    this.openSignIn = openSignIn;
    this.signOutWithClerk = signOut;
    this.getTokenWithClerk = getToken;
    this.setSnapshot(!isLoaded ? { status: "loading" } : isSignedIn ? { status: "signedIn" } : { status: "signedOut" });
  }

  async initialize(): Promise<void> {}
  getSnapshot(): AuthSnapshot { return this.snapshot; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async signIn(): Promise<void> { this.openSignIn?.(); }
  async completeSignIn(): Promise<void> {}
  async signOut(): Promise<void> { await this.signOutWithClerk?.(); this.setSnapshot({ status: "signedOut" }); }
  async expireSession(): Promise<void> { await this.signOut(); }
  async getAccessToken(options?: TokenOptions): Promise<string | null> { return this.getTokenWithClerk?.({ skipCache: options?.forceRefresh === true }) ?? null; }

  private setSnapshot(snapshot: AuthSnapshot): void {
    if (this.snapshot.status === snapshot.status) return;
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}

function ClerkBridge({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const clerk = useClerk();
  const client = useRef<ClerkAuthClient | null>(null);
  const [initialized, setInitialized] = useState(false);
  if (!client.current) client.current = new ClerkAuthClient();

  useEffect(() => {
    client.current?.update(isLoaded, isSignedIn, () => clerk.openSignIn(), () => clerk.signOut(), (options) => getToken(options));
  }, [clerk, getToken, isLoaded, isSignedIn]);

  useEffect(() => {
    const authClient = client.current;
    if (!authClient) return;
    let active = true;
    const unsubscribe = authClient.subscribe(() => undefined);
    void authClient.initialize().finally(() => { if (active) setInitialized(true); });
    return () => { active = false; unsubscribe(); };
  }, []);

  return <AuthContext.Provider value={initialized ? client.current : loadingAuthClient}>{children}</AuthContext.Provider>;
}

export function WebAuthProvider({ children, publishableKey }: { children: ReactNode; publishableKey: string }) {
  return <ClerkProvider publishableKey={publishableKey}><ClerkBridge>{children}</ClerkBridge></ClerkProvider>;
}
