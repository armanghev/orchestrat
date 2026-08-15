import { useEffect, useRef, useState, type ReactNode } from "react";
import { loadingAuthClient, type AuthClient } from "./auth-client";
import { AuthContext } from "./auth-context";
import { createBrowserWebAuthClient } from "./web-auth-client";

type WebAuthProviderProps =
  | { children: ReactNode; client: AuthClient; supabaseUrl?: never; supabasePublishableKey?: never; callbackUrl?: never }
  | { children: ReactNode; client?: never; supabaseUrl: string; supabasePublishableKey: string; callbackUrl: string };

let productionClient: AuthClient | null = null;
let productionSignature = "";

function getProductionClient(supabaseUrl: string, supabasePublishableKey: string, callbackUrl: string): AuthClient {
  const signature = JSON.stringify([supabaseUrl, supabasePublishableKey, callbackUrl]);
  if (!productionClient || productionSignature !== signature) {
    productionClient = createBrowserWebAuthClient(supabaseUrl, supabasePublishableKey, callbackUrl);
    productionSignature = signature;
  }
  return productionClient;
}

function disposeClient(client: AuthClient): void {
  const disposable = client as AuthClient & { dispose?: unknown };
  if (typeof disposable.dispose === "function") disposable.dispose();
}

export function WebAuthProvider(props: WebAuthProviderProps) {
  const client = props.client ?? getProductionClient(props.supabaseUrl, props.supabasePublishableKey, props.callbackUrl);
  const [initialized, setInitialized] = useState(false);
  const initialization = useRef<Promise<void> | null>(null);
  const pendingDisposal = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pendingDisposal.current) {
      clearTimeout(pendingDisposal.current);
      pendingDisposal.current = null;
    }
    let active = true;
    if (!initialization.current) initialization.current = client.initialize();
    void initialization.current.finally(() => { if (active) setInitialized(true); });
    return () => {
      active = false;
      pendingDisposal.current = setTimeout(() => {
        pendingDisposal.current = null;
        disposeClient(client);
      }, 0);
    };
  }, [client]);

  return <AuthContext.Provider value={initialized ? client : loadingAuthClient}>{props.children}</AuthContext.Provider>;
}
