import { z, type ZodType } from "zod";
import {
  authInstanceResponseSchema,
  authSessionResponseSchema,
  type AuthSessionResponse
} from "@orchestrat/protocol";
import {
  AuthRequestError,
  loadingAuthSnapshot,
  type AuthClient,
  type AuthInstance,
  type AuthSnapshot,
  type SignUpInput,
  type SignUpResult,
  type TokenOptions
} from "./auth-client";
import {
  AuthSessionStorage,
  removeLegacySupabaseSessions,
  type StoredSession
} from "./web-auth-storage";

// Refresh this long before the access token expires.
export const REFRESH_MARGIN_MS = 60_000;
const REFRESH_LOCK_NAME = "orchestrat.auth.refresh";
// Sign-out revokes the session first, but never waits on it for long.
const REVOKE_TIMEOUT_MS = 5_000;

// An invite signup also joins the project and says which one.
const signupResponseSchema = authSessionResponseSchema.extend({
  invited_project_id: z.string().uuid().nullable().optional()
});

// The subset of the Web Locks API the client needs. Holding the lock while
// refreshing keeps two tabs from presenting the same refresh token.
export type RefreshLocks = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

export type WebAuthClientOptions = {
  apiUrl: string;
  storage?: AuthSessionStorage;
  fetch?: typeof fetch;
  now?: () => number;
  locks?: RefreshLocks | null;
};

type Sent = { response: Response; data: unknown };

const errorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().max(1024),
    details: z.record(z.string(), z.unknown()).optional()
  })
});

const unauthenticated = () =>
  new AuthRequestError(
    "Your session has ended. Sign in again.",
    "UNAUTHENTICATED",
    401
  );

function retryAfterSeconds(response: Response, details: unknown) {
  const fromBody =
    typeof details === "object" && details !== null
      ? (details as Record<string, unknown>).retry_after_seconds
      : undefined;
  if (typeof fromBody === "number" && Number.isFinite(fromBody))
    return Math.max(1, Math.ceil(fromBody));
  const fromHeader = Number(response.headers.get("retry-after"));
  return Number.isFinite(fromHeader) && fromHeader > 0
    ? Math.ceil(fromHeader)
    : null;
}

function errorFromResponse(response: Response, data: unknown) {
  const parsed = errorBodySchema.safeParse(data);
  const code = parsed.success
    ? parsed.data.error.code
    : response.status === 401
      ? "UNAUTHENTICATED"
      : response.status === 429
        ? "RATE_LIMITED"
        : "INTERNAL_ERROR";
  return new AuthRequestError(
    parsed.success ? parsed.data.error.message : "The request failed.",
    code,
    response.status,
    code === "RATE_LIMITED"
      ? retryAfterSeconds(
          response,
          parsed.success ? parsed.data.error.details : undefined
        )
      : null
  );
}

function snapshotsEqual(left: AuthSnapshot, right: AuthSnapshot): boolean {
  if (left.status !== right.status) return false;
  if (left.status === "signedIn" && right.status === "signedIn")
    return left.identityKey === right.identityKey;
  return true;
}

/**
 * Email and password sessions against the API's own /auth endpoints.
 * Tokens live in localStorage so every tab shares one session.
 */
export class WebAuthClient implements AuthClient {
  private snapshot: AuthSnapshot = loadingAuthSnapshot;
  private session: StoredSession | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly baseUrl: string;
  private readonly storage: AuthSessionStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly locks: RefreshLocks | null;
  private initialization: Promise<void> | null = null;
  private instanceRequest: Promise<AuthInstance> | null = null;
  private refreshOperation: Promise<string | null> | null = null;
  private storageUnsubscribe: (() => void) | null = null;
  // False once a write failed; the session then lives in memory only and the
  // shared storage is no longer consulted.
  private storageBacked: boolean;
  // Bumped whenever the local session is replaced or cleared, so a request
  // that started before can't commit stale tokens.
  private generation = 0;
  private disposed = false;

  constructor(options: WebAuthClientOptions) {
    this.baseUrl = new URL(options.apiUrl).toString().replace(/\/$/, "");
    this.storage = options.storage ?? new AuthSessionStorage(null);
    this.storageBacked = this.storage.available;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.locks = options.locks ?? null;
  }

  initialize(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.initialization) this.initialization = this.initializeOnce();
    return this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    // Restoring is local: an expired access token is refreshed on first use.
    const stored = this.storage.read();
    if (stored && stored.refresh_expires_at > this.now()) {
      this.session = stored;
      this.setSnapshot({
        status: "signedIn",
        identityKey: stored.user.user_id
      });
    } else {
      if (stored) this.storage.clear();
      this.setSnapshot({ status: "signedOut" });
    }
    this.storageUnsubscribe = this.storage.subscribe(() =>
      this.onSharedSessionChange()
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.session = null;
    this.storageUnsubscribe?.();
    this.storageUnsubscribe = null;
    this.listeners.clear();
  }

  getSnapshot(): AuthSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getInstance(options?: { refresh?: boolean }): Promise<AuthInstance> {
    if (this.instanceRequest && !options?.refresh) return this.instanceRequest;
    const request = this.request(
      "/api/v1/auth/instance",
      { method: "GET" },
      authInstanceResponseSchema
    );
    this.instanceRequest = request;
    request.catch(() => {
      if (this.instanceRequest === request) this.instanceRequest = null;
    });
    return request;
  }

  async signIn(email: string, password: string): Promise<void> {
    const session = await this.request(
      "/api/v1/auth/login",
      { method: "POST", body: { email: email.trim(), password } },
      authSessionResponseSchema
    );
    this.commitSession(session);
  }

  async signUp(input: SignUpInput): Promise<SignUpResult> {
    const setupToken = input.setupToken?.trim();
    const session = await this.request(
      "/api/v1/auth/signup",
      {
        method: "POST",
        body: {
          email: input.email.trim(),
          password: input.password,
          full_name: input.fullName.trim(),
          ...(input.inviteToken ? { invite_token: input.inviteToken } : {}),
          ...(setupToken ? { setup_token: setupToken } : {})
        }
      },
      signupResponseSchema
    );
    // The server has an account now, so it no longer needs setup.
    this.instanceRequest = null;
    this.commitSession(session);
    return { invitedProjectId: session.invited_project_id ?? null };
  }

  async signOut(): Promise<void> {
    const session = this.session;
    if (this.disposed || !session) return;
    // Revoking by refresh token works even after the access token expired.
    await this.revoke(session.refresh_token);
    this.clearLocalSession();
  }

  async signOutEverywhere(): Promise<void> {
    await this.authorizedPost("/api/v1/auth/logout-all");
    this.clearLocalSession();
  }

  async changePassword(
    currentPassword: string,
    newPassword: string
  ): Promise<void> {
    await this.authorizedPost("/api/v1/auth/password", {
      current_password: currentPassword,
      new_password: newPassword
    });
  }

  async expireSession(): Promise<void> {
    if (this.disposed) return;
    this.clearLocalSession();
  }

  getAccessToken(options?: TokenOptions): Promise<string | null> {
    const session = this.session;
    if (this.disposed || !session) return Promise.resolve(null);
    const now = this.now();
    if (session.refresh_expires_at <= now) {
      this.clearLocalSession();
      return Promise.resolve(null);
    }
    if (
      !options?.forceRefresh &&
      session.access_expires_at - REFRESH_MARGIN_MS > now
    )
      return Promise.resolve(session.access_token);
    if (!this.refreshOperation) {
      const operation = this.refresh(
        session,
        Boolean(options?.forceRefresh)
      ).finally(() => {
        if (this.refreshOperation === operation) this.refreshOperation = null;
      });
      this.refreshOperation = operation;
    }
    return this.refreshOperation;
  }

  private refresh(
    presented: StoredSession,
    forced: boolean
  ): Promise<string | null> {
    const generation = this.generation;
    const run = () => this.refreshExclusively(presented, forced, generation);
    return this.locks ? this.locks.request(REFRESH_LOCK_NAME, run) : run();
  }

  private async refreshExclusively(
    presented: StoredSession,
    forced: boolean,
    generation: number
  ): Promise<string | null> {
    if (this.disposed) return null;
    if (generation !== this.generation)
      return this.session?.access_token ?? null;

    // Another tab may have rotated or ended this session while we waited.
    const shared = this.readShared();
    if (shared === null) {
      this.forgetSession();
      return null;
    }
    if (shared && shared.refresh_token !== presented.refresh_token) {
      this.adopt(shared);
      return shared.access_token;
    }

    let sent: Sent;
    try {
      sent = await this.send("/api/v1/auth/refresh", {
        method: "POST",
        body: { refresh_token: presented.refresh_token }
      });
    } catch {
      return this.afterTransientRefreshFailure(presented, forced);
    }
    if (this.disposed) return null;
    if (generation !== this.generation)
      return this.session?.access_token ?? null;

    if (sent.response.ok) {
      const parsed = authSessionResponseSchema.safeParse(sent.data);
      if (!parsed.success)
        return this.afterTransientRefreshFailure(presented, forced);
      this.commitSession(parsed.data);
      return parsed.data.access_token;
    }
    if (sent.response.status === 401) {
      // The API also answers 401 when another tab rotated this token in the
      // last minute. Use that tab's tokens before treating this as sign-out.
      const latest = this.readShared();
      if (latest && latest.refresh_token !== presented.refresh_token) {
        this.adopt(latest);
        return latest.access_token;
      }
      this.clearLocalSession();
      return null;
    }
    return this.afterTransientRefreshFailure(presented, forced);
  }

  // Network trouble, rate limits and server errors keep the session.
  private afterTransientRefreshFailure(
    presented: StoredSession,
    forced: boolean
  ): string | null {
    // A forced refresh follows a 401, so never replay the rejected token.
    if (forced) return null;
    return presented.access_expires_at > this.now()
      ? presented.access_token
      : null;
  }

  private onSharedSessionChange(): void {
    if (this.disposed || !this.initialization || !this.storageBacked) return;
    const shared = this.storage.read();
    if (shared === undefined) return;
    if (shared === null) {
      if (this.session) this.forgetSession();
      return;
    }
    if (shared.refresh_expires_at <= this.now()) return;
    if (
      !this.session ||
      shared.refresh_token !== this.session.refresh_token ||
      shared.access_token !== this.session.access_token
    )
      this.adopt(shared);
  }

  private readShared(): StoredSession | null | undefined {
    return this.storageBacked ? this.storage.read() : undefined;
  }

  private adopt(session: StoredSession): void {
    this.generation += 1;
    this.session = session;
    this.setSnapshot({ status: "signedIn", identityKey: session.user.user_id });
  }

  private commitSession(response: AuthSessionResponse): void {
    if (this.disposed) return;
    const now = this.now();
    const session: StoredSession = {
      version: 1,
      access_token: response.access_token,
      refresh_token: response.refresh_token,
      access_expires_at: now + response.expires_in * 1000,
      refresh_expires_at: now + response.refresh_expires_in * 1000,
      user: response.user
    };
    this.generation += 1;
    this.session = session;
    this.storageBacked = this.storage.write(session);
    this.setSnapshot({ status: "signedIn", identityKey: session.user.user_id });
  }

  // Signs this tab out without touching shared storage (it's already empty).
  private forgetSession(): void {
    this.generation += 1;
    this.session = null;
    this.setSnapshot({ status: "signedOut" });
  }

  private clearLocalSession(): void {
    if (this.disposed) return;
    this.storage.clear();
    this.forgetSession();
  }

  // Best effort: the API answers 204 for any token, and a failure here must
  // not keep anyone signed in on this device.
  private async revoke(refreshToken: string): Promise<void> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), REVOKE_TIMEOUT_MS);
    try {
      await this.send("/api/v1/auth/revoke", {
        method: "POST",
        body: { refresh_token: refreshToken },
        signal: abort.signal
      });
    } catch {
      /* Ignored; local sign-out continues. */
    } finally {
      clearTimeout(timeout);
    }
  }

  // Signed-in POSTs that answer 204: one forced refresh on 401, like ApiClient.
  private async authorizedPost(path: string, body?: unknown): Promise<void> {
    for (const forceRefresh of [false, true]) {
      const accessToken = await this.getAccessToken({ forceRefresh });
      if (!accessToken) throw unauthenticated();
      const sent = await this.send(path, { method: "POST", body, accessToken });
      if (sent.response.ok) return;
      if (sent.response.status !== 401)
        throw errorFromResponse(sent.response, sent.data);
    }
    await this.expireSession();
    throw unauthenticated();
  }

  private async request<T>(
    path: string,
    options: { method: "GET" | "POST"; body?: unknown },
    schema: ZodType<T>
  ): Promise<T> {
    const sent = await this.send(path, options);
    if (!sent.response.ok) throw errorFromResponse(sent.response, sent.data);
    const parsed = schema.safeParse(sent.data);
    if (!parsed.success)
      throw new AuthRequestError(
        "The server returned an unexpected response.",
        "INVALID_RESPONSE",
        sent.response.status
      );
    return parsed.data;
  }

  private async send(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: unknown;
      accessToken?: string;
      signal?: AbortSignal;
    }
  ): Promise<Sent> {
    const headers = new Headers({ Accept: "application/json" });
    if (options.accessToken)
      headers.set("Authorization", `Bearer ${options.accessToken}`);
    // Fastify rejects an empty body that claims to be JSON.
    if (options.body !== undefined)
      headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method,
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: "no-store",
        credentials: "omit",
        signal: options.signal
      });
    } catch {
      throw new AuthRequestError(
        "We couldn't reach the server.",
        "NETWORK_ERROR",
        null
      );
    }
    let data: unknown;
    try {
      data = response.status === 204 ? undefined : await response.json();
    } catch {
      data = undefined;
    }
    return { response, data };
  }

  private setSnapshot(snapshot: AuthSnapshot): void {
    if (snapshotsEqual(this.snapshot, snapshot)) return;
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserLocks(): RefreshLocks | null {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks || typeof locks.request !== "function") return null;
  return {
    request: <T>(name: string, callback: () => Promise<T>) =>
      locks.request(name, callback) as Promise<T>
  };
}

export function createBrowserWebAuthClient(apiUrl: string): WebAuthClient {
  const storage = browserStorage();
  removeLegacySupabaseSessions(storage);
  return new WebAuthClient({
    apiUrl,
    storage: new AuthSessionStorage(storage),
    locks: browserLocks()
  });
}
