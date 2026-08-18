import { useEffect, useState, type ReactNode } from "react";
import { loadingAuthClient, type AuthClient } from "./auth-client";
import { AuthContext } from "./auth-context";
import { createBrowserWebAuthClient } from "./web-auth-client";

type WebAuthProviderProps =
  | {
      children: ReactNode;
      client: AuthClient;
      supabaseUrl?: never;
      supabasePublishableKey?: never;
      callbackUrl?: never;
    }
  | {
      children: ReactNode;
      client?: never;
      supabaseUrl: string;
      supabasePublishableKey: string;
      callbackUrl: string;
    };

type AuthLeaseEntry = {
  client: AuthClient;
  initialization: Promise<void> | null;
  leases: number;
  pendingDisposal: ReturnType<typeof setTimeout> | null;
  remove(): void;
};

const productionEntries = new Map<string, AuthLeaseEntry>();
const injectedEntries = new WeakMap<AuthClient, AuthLeaseEntry>();

function disposeClient(client: AuthClient): void {
  const disposable = client as AuthClient & { dispose?: unknown };
  if (typeof disposable.dispose === "function") disposable.dispose();
}

function productionSignature(
  supabaseUrl: string,
  supabasePublishableKey: string,
  callbackUrl: string
): string {
  return JSON.stringify([supabaseUrl, supabasePublishableKey, callbackUrl]);
}

function getProductionEntry(
  signature: string,
  supabaseUrl: string,
  supabasePublishableKey: string,
  callbackUrl: string
): AuthLeaseEntry {
  const existing = productionEntries.get(signature);
  if (existing) return existing;
  const entry: AuthLeaseEntry = {
    client: createBrowserWebAuthClient(
      supabaseUrl,
      supabasePublishableKey,
      callbackUrl
    ),
    initialization: null,
    leases: 0,
    pendingDisposal: null,
    remove: () => {
      if (productionEntries.get(signature) === entry)
        productionEntries.delete(signature);
    }
  };
  productionEntries.set(signature, entry);
  return entry;
}

function getInjectedEntry(client: AuthClient): AuthLeaseEntry {
  const existing = injectedEntries.get(client);
  if (existing) return existing;
  const entry: AuthLeaseEntry = {
    client,
    initialization: null,
    leases: 0,
    pendingDisposal: null,
    remove: () => {
      if (injectedEntries.get(client) === entry) injectedEntries.delete(client);
    }
  };
  injectedEntries.set(client, entry);
  return entry;
}

function acquire(
  entry: AuthLeaseEntry,
  ready: (client: AuthClient) => void
): () => void {
  if (entry.pendingDisposal) {
    clearTimeout(entry.pendingDisposal);
    entry.pendingDisposal = null;
  }
  entry.leases += 1;
  if (!entry.initialization) entry.initialization = entry.client.initialize();
  let active = true;
  void entry.initialization.then(
    () => {
      if (active) ready(entry.client);
    },
    () => {
      if (active) ready(entry.client);
    }
  );
  return () => {
    if (!active) return;
    active = false;
    entry.leases -= 1;
    if (entry.leases !== 0 || entry.pendingDisposal) return;
    entry.pendingDisposal = setTimeout(() => {
      entry.pendingDisposal = null;
      if (entry.leases !== 0) return;
      entry.remove();
      disposeClient(entry.client);
    }, 0);
  };
}

export function WebAuthProvider(props: WebAuthProviderProps) {
  const signature = props.client
    ? props.client
    : productionSignature(
        props.supabaseUrl,
        props.supabasePublishableKey,
        props.callbackUrl
      );
  const [ready, setReady] = useState<{
    signature: string | AuthClient;
    client: AuthClient;
  } | null>(null);

  useEffect(() => {
    setReady((current) => (current?.signature === signature ? current : null));
    const entry = props.client
      ? getInjectedEntry(props.client)
      : getProductionEntry(
          signature as string,
          props.supabaseUrl,
          props.supabasePublishableKey,
          props.callbackUrl
        );
    return acquire(entry, (client) => setReady({ signature, client }));
  }, [
    props.callbackUrl,
    props.client,
    props.supabasePublishableKey,
    props.supabaseUrl,
    signature
  ]);

  const client =
    ready?.signature === signature ? ready.client : loadingAuthClient;
  return (
    <AuthContext.Provider value={client}>{props.children}</AuthContext.Provider>
  );
}
