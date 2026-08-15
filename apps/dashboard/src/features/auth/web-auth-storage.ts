import type { SupportedStorage } from "@supabase/supabase-js";

const providerTokenKeys = new Set(["provider_token", "provider_refresh_token"]);

function stripProviderTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripProviderTokens);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !providerTokenKeys.has(key))
      .map(([key, child]) => [key, stripProviderTokens(child)])
  );
}

export class ProviderTokenStrippingStorage implements SupportedStorage {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) {}

  getItem(key: string): string | null {
    return this.storage.getItem(key);
  }

  setItem(key: string, value: string): void {
    let safeValue = value;
    try { safeValue = JSON.stringify(stripProviderTokens(JSON.parse(value))); } catch { /* PKCE verifiers are not JSON. */ }
    this.storage.setItem(key, safeValue);
  }

  removeItem(key: string): void {
    this.storage.removeItem(key);
  }
}
