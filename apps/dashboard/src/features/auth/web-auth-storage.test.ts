import { describe, expect, it, vi } from "vitest";
import { ProviderTokenStrippingStorage } from "./web-auth-storage";

function backingStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
      removeItem: vi.fn((key: string) => { values.delete(key); })
    }
  };
}

describe("ProviderTokenStrippingStorage", () => {
  it("recursively removes OAuth provider tokens while preserving the Supabase session", () => {
    const backing = backingStorage();
    const storage = new ProviderTokenStrippingStorage(backing.storage);
    storage.setItem("session", JSON.stringify({
      access_token: "supabase-access",
      refresh_token: "supabase-refresh",
      provider_token: "github-access",
      user: { identities: [{ provider_refresh_token: "github-refresh", id: "identity-1" }] }
    }));

    expect(JSON.parse(backing.values.get("session") ?? "{}")).toEqual({
      access_token: "supabase-access",
      refresh_token: "supabase-refresh",
      user: { identities: [{ id: "identity-1" }] }
    });
    expect(backing.values.get("session")).not.toContain("github-access");
    expect(backing.values.get("session")).not.toContain("github-refresh");
  });

  it("preserves non-JSON PKCE verifier values and delegates reads/removals", () => {
    const backing = backingStorage();
    const storage = new ProviderTokenStrippingStorage(backing.storage);
    storage.setItem("pkce", "verifier/value-with-symbols");
    expect(storage.getItem("pkce")).toBe("verifier/value-with-symbols");
    storage.removeItem("pkce");
    expect(storage.getItem("pkce")).toBeNull();
  });

  it("removes provider token fields even when their values are null or nested in arrays", () => {
    const backing = backingStorage();
    const storage = new ProviderTokenStrippingStorage(backing.storage);
    storage.setItem("session", JSON.stringify([{ provider_token: null, safe: true }, { deep: { provider_refresh_token: 7 } }]));
    expect(JSON.parse(backing.values.get("session") ?? "[]")).toEqual([{ safe: true }, { deep: {} }]);
  });
});
