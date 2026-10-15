import { describe, expect, it, vi } from "vitest";
import {
  AUTH_SESSION_STORAGE_KEY,
  AuthSessionStorage,
  parseStoredSession,
  removeLegacySupabaseSessions,
  type StoredSession
} from "./web-auth-storage";

function backingStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    storage: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key);
      })
    }
  };
}

const session = (overrides: Partial<StoredSession> = {}): StoredSession => ({
  version: 1,
  access_token: "orch_sess_one",
  refresh_token: "orch_refresh_one",
  access_expires_at: 3_600_000,
  refresh_expires_at: 2_592_000_000,
  user: {
    user_id: "00000000-0000-4000-8000-000000000001",
    email: "ada@example.com",
    full_name: "Ada",
    is_instance_admin: false
  },
  ...overrides
});

describe("AuthSessionStorage", () => {
  it("writes and reads the session under a versioned key", () => {
    const backing = backingStorage();
    const storage = new AuthSessionStorage(backing.storage);
    expect(storage.write(session())).toBe(true);
    expect(AUTH_SESSION_STORAGE_KEY).toBe("orchestrat.auth.session.v1");
    expect(backing.values.has(AUTH_SESSION_STORAGE_KEY)).toBe(true);
    expect(storage.read()).toEqual(session());
  });

  it("returns null when there is no session", () => {
    expect(new AuthSessionStorage(backingStorage().storage).read()).toBeNull();
  });

  it.each([
    ["malformed JSON", "{"],
    ["an empty value", ""],
    ["another shape", JSON.stringify({ access_token: "x" })],
    ["an older version", JSON.stringify({ ...session(), version: 0 })],
    ["an oversized value", JSON.stringify({ pad: "x".repeat(20_000) })]
  ])("removes %s instead of trusting it", (_label, raw) => {
    const backing = backingStorage({ [AUTH_SESSION_STORAGE_KEY]: raw });
    const storage = new AuthSessionStorage(backing.storage);
    expect(storage.read()).toBeNull();
    expect(backing.values.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
  });

  it("reports unreadable storage as undefined, not as signed out", () => {
    const storage = new AuthSessionStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
      removeItem: () => undefined
    });
    expect(storage.read()).toBeUndefined();
    expect(new AuthSessionStorage(null).read()).toBeUndefined();
  });

  it("reports a failed write so the client can keep the session in memory", () => {
    const backing = backingStorage();
    backing.storage.setItem.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const storage = new AuthSessionStorage(backing.storage);
    expect(storage.write(session())).toBe(false);
    expect(new AuthSessionStorage(null).write(session())).toBe(false);
  });

  it("clears the session and tolerates storage that throws", () => {
    const backing = backingStorage({
      [AUTH_SESSION_STORAGE_KEY]: JSON.stringify(session())
    });
    new AuthSessionStorage(backing.storage).clear();
    expect(backing.values.size).toBe(0);
    expect(() =>
      new AuthSessionStorage({
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => {
          throw new Error("blocked");
        }
      }).clear()
    ).not.toThrow();
  });

  it("notifies only for its own key or a full clear from another tab", () => {
    const listener = vi.fn();
    const stop = new AuthSessionStorage(backingStorage().storage).subscribe(
      listener
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "orchestrat.preferences" })
    );
    expect(listener).not.toHaveBeenCalled();
    window.dispatchEvent(
      new StorageEvent("storage", { key: AUTH_SESSION_STORAGE_KEY })
    );
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    window.dispatchEvent(
      new StorageEvent("storage", { key: AUTH_SESSION_STORAGE_KEY })
    );
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("parseStoredSession", () => {
  it("rejects negative expiry times", () => {
    expect(
      parseStoredSession(JSON.stringify(session({ access_expires_at: -1 })))
    ).toBeNull();
  });
});

describe("removeLegacySupabaseSessions", () => {
  it("drops hosted-alpha Supabase sessions and keeps everything else", () => {
    localStorage.clear();
    localStorage.setItem("sb-abcdefgh-auth-token", "{}");
    localStorage.setItem("sb-abcdefgh-auth-token-code-verifier", "x");
    localStorage.setItem("orchestrat.preferences", "{}");
    localStorage.setItem(AUTH_SESSION_STORAGE_KEY, "{}");
    removeLegacySupabaseSessions(localStorage);
    const keys = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index)
    );
    expect(keys.sort()).toEqual(
      [AUTH_SESSION_STORAGE_KEY, "orchestrat.preferences"].sort()
    );
    localStorage.clear();
  });

  it("ignores missing storage", () => {
    expect(() => removeLegacySupabaseSessions(null)).not.toThrow();
  });
});
