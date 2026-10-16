import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PublicConfig } from "@/app/config";
import { loadingAuthClient, type AuthClient } from "./auth-client";
import { AuthContext } from "./auth-context";
import { WebAuthProvider } from "./web-auth-provider";

// The e2e build stubs auth unless a spec opts into the real password client
// (against mocked /api/v1/auth routes) with this stored mode.
export const E2E_AUTH_MODE_KEY = "orchestrat.e2e.auth";
export const E2E_PASSWORD_MODE = "password";

function e2eUsesPasswordClient(): boolean {
  try {
    return window.localStorage.getItem(E2E_AUTH_MODE_KEY) === E2E_PASSWORD_MODE;
  } catch {
    return false;
  }
}

function disposeClient(client: AuthClient): void {
  const disposable = client as AuthClient & { dispose?: unknown };
  if (typeof disposable.dispose === "function") disposable.dispose();
}

function ClientProvider({
  client,
  children
}: {
  client: AuthClient;
  children: ReactNode;
}) {
  const [initialized, setInitialized] = useState(false);
  const pendingDisposals = useRef(
    new Map<AuthClient, ReturnType<typeof setTimeout>>()
  );
  useEffect(() => {
    const pendingDisposal = pendingDisposals.current.get(client);
    if (pendingDisposal) {
      clearTimeout(pendingDisposal);
      pendingDisposals.current.delete(client);
    }
    let active = true;
    const unsubscribe = client.subscribe(() => undefined);
    void client.initialize().finally(() => {
      if (active) setInitialized(true);
    });
    return () => {
      active = false;
      unsubscribe();
      // StrictMode replays effects synchronously, so its next setup cancels this.
      const disposal = setTimeout(() => {
        pendingDisposals.current.delete(client);
        disposeClient(client);
      }, 0);
      pendingDisposals.current.set(client, disposal);
    };
  }, [client]);
  return (
    <AuthContext.Provider value={initialized ? client : loadingAuthClient}>
      {children}
    </AuthContext.Provider>
  );
}

function E2eProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<AuthClient | null>(null);
  useEffect(() => {
    let active = true;
    void import("../../test/e2e-auth-client").then(({ E2eAuthClient }) => {
      if (active) setClient(new E2eAuthClient());
    });
    return () => {
      active = false;
    };
  }, []);
  return (
    <AuthContext.Provider value={client ?? loadingAuthClient}>
      {client ? (
        <ClientProvider client={client}>{children}</ClientProvider>
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}

export function AuthProvider({
  children,
  config
}: {
  children: ReactNode;
  config: PublicConfig;
}) {
  if (config.e2eAuth) {
    if (import.meta.env.MODE !== "e2e") {
      return (
        <p role="alert">E2E authentication is only available in e2e mode.</p>
      );
    }
    if (!e2eUsesPasswordClient()) return <E2eProvider>{children}</E2eProvider>;
  }
  // The desktop app is a webview on the same API, so it signs in with the
  // same password client. Its native browser sign-in returns in v1.1.
  return <WebAuthProvider apiUrl={config.apiUrl}>{children}</WebAuthProvider>;
}
