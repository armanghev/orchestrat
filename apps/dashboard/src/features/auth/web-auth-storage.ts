import { z } from "zod";

// One session per browser profile, shared by every tab. Bump the version in
// the key when the shape changes; older values are then simply ignored.
export const AUTH_SESSION_STORAGE_KEY = "orchestrat.auth.session.v1";

const maxSerializedLength = 16_384;

const storedSessionSchema = z.object({
  version: z.literal(1),
  access_token: z.string().min(1).max(512),
  refresh_token: z.string().min(1).max(512),
  // Epoch milliseconds, computed from this device's clock when the tokens
  // arrived, so server clock skew doesn't matter.
  access_expires_at: z.number().int().nonnegative(),
  refresh_expires_at: z.number().int().nonnegative(),
  user: z.object({
    user_id: z.string().min(1).max(128),
    email: z.string().max(320),
    full_name: z.string().max(256),
    is_instance_admin: z.boolean()
  })
});
export type StoredSession = z.infer<typeof storedSessionSchema>;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function parseStoredSession(value: string): StoredSession | null {
  if (value.length === 0 || value.length > maxSerializedLength) return null;
  try {
    const parsed = storedSessionSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class AuthSessionStorage {
  constructor(
    private readonly storage: StorageLike | null,
    private readonly key = AUTH_SESSION_STORAGE_KEY
  ) {}

  get available(): boolean {
    return this.storage !== null;
  }

  /**
   * The shared session, `null` when there is none, or `undefined` when the
   * storage can't be read at all. An unreadable or malformed value is removed.
   */
  read(): StoredSession | null | undefined {
    if (!this.storage) return undefined;
    let value: string | null;
    try {
      value = this.storage.getItem(this.key);
    } catch {
      return undefined;
    }
    if (value === null) return null;
    const session = parseStoredSession(value);
    if (!session) this.clear();
    return session;
  }

  /** Returns false when the session could only be kept in memory. */
  write(session: StoredSession): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(this.key, JSON.stringify(session));
      return true;
    } catch {
      this.clear();
      return false;
    }
  }

  clear(): void {
    try {
      this.storage?.removeItem(this.key);
    } catch {
      /* Storage cleanup is best-effort. */
    }
  }

  /** Calls the listener when another tab changes the shared session. */
  subscribe(listener: () => void): () => void {
    if (typeof window === "undefined") return () => undefined;
    const handler = (event: StorageEvent) => {
      // A null key means the other tab cleared all of storage.
      if (event.key === null || event.key === this.key) listener();
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }
}

// The hosted alpha kept Supabase sessions under `sb-<project>-auth-token`.
// They are useless now, so drop them instead of leaving tokens behind.
const legacySupabaseKey = /^sb-[A-Za-z0-9-]+-auth-token(?:-code-verifier)?$/u;

export function removeLegacySupabaseSessions(
  storage: Pick<Storage, "key" | "length" | "removeItem"> | null
): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && legacySupabaseKey.test(key)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* Best-effort cleanup. */
  }
}
