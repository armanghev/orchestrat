import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PublicConfig } from "@/app/config";
import type { Platform } from "@/platform/contract";
import { desktopAuthBridge } from "./desktop-bridge";
import { DesktopAuthClient } from "./desktop-auth-client";
import { loadingAuthClient, type AuthClient } from "./auth-client";
import { AuthContext } from "./auth-context";
import { WebAuthProvider } from "./web-auth-provider";

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

function DesktopProvider({
  platform,
  children
}: {
  platform: Platform;
  children: ReactNode;
}) {
  const client = useMemo(
    () => new DesktopAuthClient(platform, desktopAuthBridge),
    [platform]
  );
  return <ClientProvider client={client}>{children}</ClientProvider>;
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
  config,
  platform
}: {
  children: ReactNode;
  config: PublicConfig;
  platform: Platform;
}) {
  if (config.e2eAuth) {
    if (import.meta.env.MODE !== "e2e") {
      return (
        <p role="alert">E2E authentication is only available in e2e mode.</p>
      );
    }
    return <E2eProvider>{children}</E2eProvider>;
  }
  if (platform.kind === "desktop")
    return <DesktopProvider platform={platform}>{children}</DesktopProvider>;
  if (
    !config.supabaseUrl ||
    !config.supabasePublishableKey ||
    !config.webAuthCallbackUrl
  ) {
    return <p role="alert">Dashboard configuration is invalid.</p>;
  }
  return (
    <WebAuthProvider
      supabaseUrl={config.supabaseUrl}
      supabasePublishableKey={config.supabasePublishableKey}
      callbackUrl={config.webAuthCallbackUrl}
    >
      {children}
    </WebAuthProvider>
  );
}
