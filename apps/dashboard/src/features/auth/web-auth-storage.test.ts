import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { ProviderTokenStrippingStorage } from "./web-auth-storage";

function backingStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
      removeItem: vi.fn((key: string) => { values.delete(key); })
    }
  };
}

const unsafeSession = () => ({
  access_token: "supabase-access",
  refresh_token: "supabase-refresh",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  token_type: "bearer",
  provider_token: "github-access",
  provider_refresh_token: "github-refresh",
  user: {
    id: "user-storage", aud: "authenticated", role: "authenticated", email: "person@example.com",
    app_metadata: {}, user_metadata: {}, identities: [{ id: "identity-1", provider_token: "nested-provider" }],
    created_at: "2026-01-01T00:00:00.000Z"
  }
});

describe("ProviderTokenStrippingStorage", () => {
  it("recursively removes OAuth provider tokens while preserving the Supabase session", () => {
    const backing = backingStorage();
    const storage = new ProviderTokenStrippingStorage(backing.storage);
    storage.setItem("session", JSON.stringify(unsafeSession()));
    const stored = JSON.parse(backing.values.get("session") ?? "{}");
    expect(stored.access_token).toBe("supabase-access");
    expect(stored.user.identities).toEqual([{ id: "identity-1" }]);
    expect(backing.values.get("session")).not.toContain("github-access");
    expect(backing.values.get("session")).not.toContain("github-refresh");
    expect(backing.values.get("session")).not.toContain("nested-provider");
  });

  it("migrates and sanitizes a preexisting session on read before returning it", () => {
    const raw = JSON.stringify(unsafeSession());
    const backing = backingStorage({ session: raw });
    const storage = new ProviderTokenStrippingStorage(backing.storage);
    const returned = storage.getItem("session");
    expect(returned).not.toContain("github-access");
    expect(returned).not.toContain("github-refresh");
    expect(backing.values.get("session")).toBe(returned);
    expect(backing.storage.setItem).toHaveBeenCalledWith("session", returned);
  });

  it("roundtrips JSON-serialized PKCE verifiers, indexes, and normal sessions", () => {
    const backing = backingStorage();
    const storage = new ProviderTokenStrippingStorage(backing.storage);
    const values = [JSON.stringify("verifier/value-with-symbols"), JSON.stringify(["session-key"]), JSON.stringify({ currentSession: null })];
    values.forEach((value, index) => {
      const key = `safe-${index}`;
      storage.setItem(key, value);
      expect(storage.getItem(key)).toBe(value);
    });
  });

  it.each(["{malformed", `${"[".repeat(80)}0${"]".repeat(80)}`, JSON.stringify("x".repeat(1_100_000))])(
    "fails closed and removes malformed, deep, or excessive stored input",
    (raw) => {
      const backing = backingStorage({ unsafe: raw });
      const storage = new ProviderTokenStrippingStorage(backing.storage);
      expect(storage.getItem("unsafe")).toBeNull();
      expect(backing.values.has("unsafe")).toBe(false);
      expect(backing.storage.setItem).not.toHaveBeenCalled();
    }
  );

  it("never preserves a prior raw value when a new write cannot be sanitized", () => {
    const backing = backingStorage({ session: JSON.stringify(unsafeSession()) });
    const storage = new ProviderTokenStrippingStorage(backing.storage);
    storage.setItem("session", "not-json-auth-data");
    expect(backing.values.has("session")).toBe(false);
  });

  it("sanitizes a preexisting auth-js 2.112.3 session in storage and getSession", async () => {
    const key = "sb-project-auth-token";
    const backing = backingStorage({ [key]: JSON.stringify(unsafeSession()) });
    const safeStorage = new ProviderTokenStrippingStorage(backing.storage);
    const client = createClient("https://project.supabase.co", "sb_publishable_abcdefghijklmnopqrstuvwxyz123456", {
      auth: { storage: safeStorage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const result = await client.auth.getSession();
    expect(result.error).toBeNull();
    expect(result.data.session).toMatchObject({ access_token: "supabase-access", user: { id: "user-storage" } });
    expect(result.data.session).not.toHaveProperty("provider_token");
    expect(result.data.session?.user.identities?.[0]).not.toHaveProperty("provider_token");
    expect(backing.values.get(key)).not.toContain("github-access");
    expect(backing.values.get(key)).not.toContain("nested-provider");
    await client.auth.dispose();
  });
});
