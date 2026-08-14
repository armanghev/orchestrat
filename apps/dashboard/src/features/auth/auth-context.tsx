import { createContext, useContext, useSyncExternalStore } from "react";
import type { AuthClient, AuthSnapshot } from "./auth-client";

export const AuthContext = createContext<AuthClient | null>(null);

export function useAuthClient(): AuthClient {
  const client = useContext(AuthContext);
  if (!client) throw new Error("useAuthClient must be used within AuthContext.");
  return client;
}

export function useAuthSnapshot(): AuthSnapshot {
  const client = useAuthClient();
  return useSyncExternalStore(
    client.subscribe.bind(client),
    client.getSnapshot.bind(client),
    client.getSnapshot.bind(client)
  );
}
