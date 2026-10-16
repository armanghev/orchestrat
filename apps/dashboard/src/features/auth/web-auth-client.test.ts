import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthRequestError } from "./auth-client";
import {
  REFRESH_MARGIN_MS,
  WebAuthClient,
  type RefreshLocks
} from "./web-auth-client";
import {
  AUTH_SESSION_STORAGE_KEY,
  AuthSessionStorage,
  type StoredSession
} from "./web-auth-storage";

const apiUrl = "https://api.test";
const userId = "00000000-0000-4000-8000-000000000001";
const otherUserId = "00000000-0000-4000-8000-000000000002";
const start = 1_000_000;
const hour = 3_600_000;

type Call = {
  key: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
};
type Handler = (call: Call) => Response | Promise<Response>;

function json(status: number, body?: unknown, headers?: HeadersInit) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function apiError(status: number, code: string, details = {}) {
  return json(status, {
    error: { code, message: code, details, request_id: "req_1" }
  });
}

function sessionBody(n: number, user = userId) {
  return {
    access_token: `orch_sess_${n}`,
    refresh_token: `orch_refresh_${n}`,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_expires_in: 2_592_000,
    user: {
      user_id: user,
      email: "ada@example.com",
      full_name: "Ada",
      is_instance_admin: false
    }
  };
}

function stored(
  n: number,
  {
    accessExpiresAt = start + hour,
    refreshExpiresAt = start + 30 * 24 * hour,
    user = userId
  } = {}
): StoredSession {
  const body = sessionBody(n, user);
  return {
    version: 1,
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    access_expires_at: accessExpiresAt,
    refresh_expires_at: refreshExpiresAt,
    user: body.user
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup({
  session,
  locks = null
}: { session?: StoredSession; locks?: RefreshLocks | null } = {}) {
  const values = new Map<string, string>();
  if (session) values.set(AUTH_SESSION_STORAGE_KEY, JSON.stringify(session));
  const backing = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    })
  };
  const routes: Record<string, Handler> = {};
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      key: `${init?.method ?? "GET"} ${url.pathname}`,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    };
    calls.push(call);
    const handler = routes[call.key];
    return handler ? handler(call) : json(404, { unexpected: call.key });
  });
  const clock = { now: start };
  const client = new WebAuthClient({
    apiUrl,
    storage: new AuthSessionStorage(backing),
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => clock.now,
    locks
  });
  const shared = () => {
    const raw = values.get(AUTH_SESSION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  };
  // Another tab changing the shared session, then the browser telling us.
  const otherTabWrites = (value: StoredSession | null) => {
    if (value) values.set(AUTH_SESSION_STORAGE_KEY, JSON.stringify(value));
    else values.delete(AUTH_SESSION_STORAGE_KEY);
    window.dispatchEvent(
      new StorageEvent("storage", { key: AUTH_SESSION_STORAGE_KEY })
    );
  };
  // Another tab changing it before this tab has heard about it.
  const otherTabWritesQuietly = (value: StoredSession) =>
    values.set(AUTH_SESSION_STORAGE_KEY, JSON.stringify(value));
  return {
    client,
    routes,
    calls,
    clock,
    backing,
    shared,
    otherTabWrites,
    otherTabWritesQuietly
  };
}

const clients: WebAuthClient[] = [];
async function ready(env: ReturnType<typeof setup>) {
  clients.push(env.client);
  await env.client.initialize();
  return env;
}

afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
});

const signedIn = { status: "signedIn", identityKey: userId };

describe("WebAuthClient session restore", () => {
  it("starts signed out without a stored session", async () => {
    const { client, calls } = await ready(setup());
    expect(client.getSnapshot()).toEqual({ status: "signedOut" });
    await expect(client.getAccessToken()).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("restores a stored session locally, keyed by user id", async () => {
    const { client, calls } = await ready(setup({ session: stored(1) }));
    expect(client.getSnapshot()).toEqual(signedIn);
    await expect(client.getAccessToken()).resolves.toBe("orch_sess_1");
    expect(calls).toHaveLength(0);
  });

  it("drops a stored session whose refresh token already expired", async () => {
    const env = await ready(
      setup({ session: stored(1, { refreshExpiresAt: start - 1 }) })
    );
    expect(env.client.getSnapshot()).toEqual({ status: "signedOut" });
    expect(env.shared()).toBeNull();
  });
});

describe("WebAuthClient sign-in", () => {
  it("signs in with email and password and stores both tokens", async () => {
    const env = await ready(setup());
    env.routes["POST /api/v1/auth/login"] = () => json(200, sessionBody(1));
    const listener = vi.fn();
    env.client.subscribe(listener);

    await env.client.signIn("  ada@example.com ", "correct horse battery");

    expect(env.calls[0]).toMatchObject({
      key: "POST /api/v1/auth/login",
      body: { email: "ada@example.com", password: "correct horse battery" }
    });
    expect(env.calls[0]!.headers.get("authorization")).toBeNull();
    expect(env.client.getSnapshot()).toEqual(signedIn);
    expect(listener).toHaveBeenCalled();
    expect(env.shared()).toEqual({
      ...stored(1),
      access_expires_at: start + hour,
      refresh_expires_at: start + 2_592_000_000
    });
    await expect(env.client.getAccessToken()).resolves.toBe("orch_sess_1");
  });

  it("rejects a wrong password with its code and stays signed out", async () => {
    const env = await ready(setup());
    env.routes["POST /api/v1/auth/login"] = () =>
      apiError(401, "INVALID_CREDENTIALS");
    const failure = env.client.signIn("ada@example.com", "wrong-password");
    await expect(failure).rejects.toBeInstanceOf(AuthRequestError);
    await expect(failure).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
      status: 401
    });
    expect(env.client.getSnapshot()).toEqual({ status: "signedOut" });
    expect(env.shared()).toBeNull();
  });

  it("reports how long a rate-limited sign-in must wait", async () => {
    const env = await ready(setup());
    env.routes["POST /api/v1/auth/login"] = () =>
      apiError(429, "RATE_LIMITED", { retry_after_seconds: 42 });
    await expect(
      env.client.signIn("ada@example.com", "secret-password")
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 42 });

    env.routes["POST /api/v1/auth/login"] = () =>
      json(429, undefined, { "retry-after": "7" });
    await expect(
      env.client.signIn("ada@example.com", "secret-password")
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 7 });
  });

  it("reports an unreachable server as a network error", async () => {
    const env = await ready(setup());
    env.routes["POST /api/v1/auth/login"] = () => {
      throw new TypeError("Failed to fetch");
    };
    await expect(
      env.client.signIn("ada@example.com", "secret-password")
    ).rejects.toMatchObject({ code: "NETWORK_ERROR", status: null });
  });

  it("rejects a malformed session response", async () => {
    const env = await ready(setup());
    env.routes["POST /api/v1/auth/login"] = () =>
      json(200, { access_token: "x" });
    await expect(
      env.client.signIn("ada@example.com", "secret-password")
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(env.client.getSnapshot()).toEqual({ status: "signedOut" });
  });
});

describe("WebAuthClient instance and sign-up", () => {
  it("caches instance info until asked to refresh", async () => {
    const env = await ready(setup());
    let needsSetup = true;
    env.routes["GET /api/v1/auth/instance"] = () =>
      json(200, { needs_setup: needsSetup, signup_mode: "invite" });
    await expect(env.client.getInstance()).resolves.toEqual({
      needs_setup: true,
      signup_mode: "invite"
    });
    needsSetup = false;
    await expect(env.client.getInstance()).resolves.toMatchObject({
      needs_setup: true
    });
    await expect(
      env.client.getInstance({ refresh: true })
    ).resolves.toMatchObject({ needs_setup: false });
    expect(env.calls).toHaveLength(2);
  });

  it("creates the first admin with the setup token and forgets the setup state", async () => {
    const env = await ready(setup());
    let needsSetup = true;
    env.routes["GET /api/v1/auth/instance"] = () =>
      json(200, { needs_setup: needsSetup, signup_mode: "invite" });
    env.routes["POST /api/v1/auth/signup"] = () => {
      needsSetup = false;
      return json(201, sessionBody(1));
    };
    await env.client.getInstance();

    await expect(
      env.client.signUp({
        email: "ada@example.com",
        password: "correct horse battery",
        fullName: "  Ada Lovelace ",
        setupToken: " setup-123 "
      })
    ).resolves.toEqual({ invitedProjectId: null });

    expect(env.calls[1]!.body).toEqual({
      email: "ada@example.com",
      password: "correct horse battery",
      full_name: "Ada Lovelace",
      setup_token: "setup-123"
    });
    expect(env.client.getSnapshot()).toEqual(signedIn);
    await expect(env.client.getInstance()).resolves.toMatchObject({
      needs_setup: false
    });
  });

  it("signs up with an invite and returns the joined project", async () => {
    const env = await ready(setup());
    const projectId = "00000000-0000-4000-8000-000000000099";
    env.routes["POST /api/v1/auth/signup"] = () =>
      json(201, { ...sessionBody(1), invited_project_id: projectId });
    await expect(
      env.client.signUp({
        email: "ada@example.com",
        password: "correct horse battery",
        fullName: "Ada",
        inviteToken: "a".repeat(43)
      })
    ).resolves.toEqual({ invitedProjectId: projectId });
    expect(env.calls[0]!.body).toMatchObject({ invite_token: "a".repeat(43) });
    expect(env.calls[0]!.body).not.toHaveProperty("setup_token");
  });

  it.each([
    [403, "SETUP_TOKEN_REQUIRED"],
    [403, "INVITE_REQUIRED"],
    [403, "SIGNUP_CLOSED"],
    [409, "EMAIL_TAKEN"]
  ])("surfaces a %s %s sign-up error", async (status, code) => {
    const env = await ready(setup());
    env.routes["POST /api/v1/auth/signup"] = () => apiError(status, code);
    await expect(
      env.client.signUp({
        email: "ada@example.com",
        password: "correct horse battery",
        fullName: "Ada"
      })
    ).rejects.toMatchObject({ code, status });
    expect(env.client.getSnapshot()).toEqual({ status: "signedOut" });
  });
});

describe("WebAuthClient token refresh", () => {
  it("refreshes about a minute before expiry and rotates both tokens", async () => {
    const env = await ready(setup({ session: stored(1) }));
    env.routes["POST /api/v1/auth/refresh"] = () => json(200, sessionBody(2));

    env.clock.now = start + hour - REFRESH_MARGIN_MS - 1;
    await expect(env.client.getAccessToken()).resolves.toBe("orch_sess_1");
    expect(env.calls).toHaveLength(0);

    env.clock.now = start + hour - REFRESH_MARGIN_MS + 1;
    await expect(env.client.getAccessToken()).resolves.toBe("orch_sess_2");
    expect(env.calls[0]).toMatchObject({
      key: "POST /api/v1/auth/refresh",
      body: { refresh_token: "orch_refresh_1" }
    });
    expect(env.shared()).toMatchObject({
      access_token: "orch_sess_2",
      refresh_token: "orch_refresh_2",
      access_expires_at: env.clock.now + hour
    });
    expect(env.client.getSnapshot()).toEqual(signedIn);
  });

  it("shares one refresh between concurrent callers", async () => {
    const env = await ready(setup({ session: stored(1) }));
    const response = deferred<Response>();
    env.routes["POST /api/v1/auth/refresh"] = () => response.promise;

    const first = env.client.getAccessToken({ forceRefresh: true });
    const second = env.client.getAccessToken({ forceRefresh: true });
    response.resolve(json(200, sessionBody(2)));

    await expect(Promise.all([first, second])).resolves.toEqual([
      "orch_sess_2",
      "orch_sess_2"
    ]);
    expect(env.calls).toHaveLength(1);
  });

  it("refreshes inside the cross-tab lock when Web Locks are available", async () => {
    const request = vi.fn(
      <T>(_name: string, callback: () => Promise<T>): Promise<T> => callback()
    );
    const env = await ready(
      setup({
        session: stored(1),
        locks: { request: request as RefreshLocks["request"] }
      })
    );
    env.routes["POST /api/v1/auth/refresh"] = () => json(200, sessionBody(2));
    await expect(
      env.client.getAccessToken({ forceRefresh: true })
    ).resolves.toBe("orch_sess_2");
    expect(request).toHaveBeenCalledWith(
      "orchestrat.auth.refresh",
      expect.any(Function)
    );
  });

  it("uses tokens another tab already rotated instead of refreshing again", async () => {
    const env = await ready(setup({ session: stored(1) }));
    env.otherTabWritesQuietly(stored(2));
    await expect(
      env.client.getAccessToken({ forceRefresh: true })
    ).resolves.toBe("orch_sess_2");
    expect(env.calls).toHaveLength(0);
  });

  it("keeps the session when a refresh 401 follows another tab's rotation", async () => {
    const env = await ready(setup({ session: stored(1) }));
    env.routes["POST /api/v1/auth/refresh"] = () => {
      // The other tab won the race and saved its tokens first.
      env.otherTabWritesQuietly(stored(2));
      return apiError(401, "REFRESH_TOKEN_INVALID");
    };
    await expect(
      env.client.getAccessToken({ forceRefresh: true })
    ).resolves.toBe("orch_sess_2");
    expect(env.client.getSnapshot()).toEqual(signedIn);
    expect(env.shared()).toMatchObject({ refresh_token: "orch_refresh_2" });
  });

  it("signs out on a definitive refresh 401", async () => {
    const env = await ready(setup({ session: stored(1) }));
    env.routes["POST /api/v1/auth/refresh"] = () =>
      apiError(401, "REFRESH_TOKEN_INVALID");
    await expect(
      env.client.getAccessToken({ forceRefresh: true })
    ).resolves.toBeNull();
    expect(env.client.getSnapshot()).toEqual({ status: "signedOut" });
    expect(env.shared()).toBeNull();
  });

  it("signs out without a request once the refresh token has expired", async () => {
    const env = await ready(setup({ session: stored(1) }));
    env.clock.now = start + 30 * 24 * hour;
    await expect(env.client.getAccessToken()).resolves.toBeNull();
    expect(env.calls).toHaveLength(0);
    expect(env.client.getSnapshot()).toEqual({ status: "signedOut" });
    expect(env.shared()).toBeNull();
  });

  it("keeps the session through a transient failure but never replays a rejected token", async () => {
    const env = await ready(setup({ session: stored(1) }));
    env.routes["POST /api/v1/auth/refresh"] = () =>
      apiError(503, "INTERNAL_ERROR");

    await expect(
      env.client.getAccessToken({ forceRefresh: true })
    ).resolves.toBeNull();
    expect(env.client.getSnapshot()).toEqual(signedIn);

    // A proactive refresh may keep using a token that is still valid.
    env.clock.now = start + hour - 30_000;
    await expect(env.client.getAccessToken()).resolves.toBe("orch_sess_1");

    env.routes["POST /api/v1/auth/refresh"] = () => {
      throw new TypeError("offline");
    };
    env.clock.now = start + hour + 1;
    await expect(env.client.getAccessToken()).resolves.toBeNull();
    expect(env.shared()).toMatchObject({ refresh_token: "orch_refresh_1" });

    env.routes["POST /api/v1/auth/refresh"] = () => json(200, sessionBody(2));
    await expect(env.client.getAccessToken()).resolves.toBe("orch_sess_2");
  });

  it("drops a refresh that finishes after the session ended", async () => {
    const env = await ready(setup({ session: stored(1) }));
    const response = deferred<Response>();
    env.routes["POST /api/v1/auth/refresh"] = () => response.promise;
    const token = env.client.getAccessToken({ forceRefresh: true });
    await env.client.expireSession();
    response.resolve(json(200, sessionBody(2)));
    await expect(token).resolves.toBeNull();
    expect(env.client.getSnapshot()).toEqual({ status: "signedOut" });
    expect(env.shared()).toBeNull();
  });
});

describe("WebAuthClient across tabs", () => {
  it("follows another tab's rotation, sign-out and sign-in", async () => {
    const env = await ready(setup({ session: stored(1) }));
    const listener = vi.fn();
    env.client.subscribe(listener);

    env.otherTabWrites(stored(2));
    await expect(env.client.getAccessToken()).resolves.toBe("orch_sess_2");
    expect(listener).not.toHaveBeenCalled();

    env.otherTabWrites(null);
    expect(env.client.getSnapshot()).toEqual({ status: "signedOut" });

    env.otherTabWrites(stored(3, { user: otherUserId }));
    expect(env.client.getSnapshot()).toEqual({
      status: "signedIn",
      identityKey: otherUserId
    });
  });

  it("stops listening after dispose", async () => {
    const env = await ready(setup({ session: stored(1) }));
    env.client.dispose();
    env.otherTabWrites(null);
    expect(env.client.getSnapshot()).toEqual(signedIn);
  });

  it("keeps working in memory when storage refuses writes", async () => {
    const env = await ready(setup());
    env.backing.setItem.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    env.routes["POST /api/v1/auth/login"] = () => json(200, sessionBody(1));
    await env.client.signIn("ada@example.com", "secret-password");
    env.routes["POST /api/v1/auth/refresh"] = () => json(200, sessionBody(2));
    await expect(
      env.client.getAccessToken({ forceRefresh: true })
    ).resolves.toBe("orch_sess_2");
    expect(env.client.getSnapshot()).toEqual(signedIn);
  });
});

describe("WebAuthClient sign-out and account actions", () => {
  it("revokes by refresh token on sign-out, then clears the session", async () => {
    const env = await ready(
      setup({ session: stored(1, { accessExpiresAt: start - 1 }) })
    );
    let sharedDuringRevoke: StoredSession | null = null;
    env.routes["POST /api/v1/auth/revoke"] = () => {
      sharedDuringRevoke = env.shared();
      return new Response(null, { status: 204 });
    };
    await env.client.signOut();
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0]).toMatchObject({
      key: "POST /api/v1/auth/revoke",
      body: { refresh_token: "orch_refresh_1" }
    });
    expect(env.calls[0]!.headers.get("authorization")).toBeNull();
    expect(sharedDuringRevoke).not.toBeNull();
    expect(env.client.getSnapshot()).toEqual({ status: "signedOut" });
    expect(env.shared()).toBeNull();
  });

  it("signs out locally even when revoke can't reach the server", async () => {
    const env = await ready(setup({ session: stored(1) }));
    env.routes["POST /api/v1/auth/revoke"] = () => {
      throw new TypeError("offline");
    };
    await env.client.signOut();
    expect(env.client.getSnapshot()).toEqual({ status: "signedOut" });
    expect(env.shared()).toBeNull();
  });

  it("signs out everywhere with the bearer token", async () => {
    const env = await ready(setup({ session: stored(1) }));
    env.routes["POST /api/v1/auth/logout-all"] = () =>
      new Response(null, { status: 204 });
    await env.client.signOutEverywhere();
    expect(env.calls[0]!.headers.get("authorization")).toBe(
      "Bearer orch_sess_1"
    );
    // An empty JSON body would be rejected by the API.
    expect(env.calls[0]!.headers.get("content-type")).toBeNull();
    expect(env.client.getSnapshot()).toEqual({ status: "signedOut" });
    expect(env.shared()).toBeNull();
  });

  it("stays signed in when sign out everywhere fails", async () => {
    const env = await ready(setup({ session: stored(1) }));
    env.routes["POST /api/v1/auth/logout-all"] = () =>
      apiError(500, "INTERNAL_ERROR");
    await expect(env.client.signOutEverywhere()).rejects.toMatchObject({
      code: "INTERNAL_ERROR"
    });
    expect(env.client.getSnapshot()).toEqual(signedIn);
  });

  it("changes the password and keeps this session", async () => {
    const env = await ready(setup({ session: stored(1) }));
    env.routes["POST /api/v1/auth/password"] = () =>
      new Response(null, { status: 204 });
    await env.client.changePassword("old-password", "new password 123");
    expect(env.calls[0]).toMatchObject({
      key: "POST /api/v1/auth/password",
      body: {
        current_password: "old-password",
        new_password: "new password 123"
      }
    });
    expect(env.calls[0]!.headers.get("authorization")).toBe(
      "Bearer orch_sess_1"
    );
    expect(env.client.getSnapshot()).toEqual(signedIn);
    expect(env.shared()).toMatchObject({ access_token: "orch_sess_1" });
  });

  it.each([
    [
      "an incorrect current password",
      () => apiError(403, "PASSWORD_INCORRECT"),
      { code: "PASSWORD_INCORRECT", status: 403 }
    ],
    [
      "the rate limit",
      () =>
        json(
          429,
          {
            error: {
              code: "RATE_LIMITED",
              message: "Too many requests.",
              details: { retry_after_seconds: 900 },
              request_id: "req"
            }
          },
          { "retry-after": "900" }
        ),
      { code: "RATE_LIMITED", retryAfterSeconds: 900 }
    ]
  ])("reports %s on password change", async (_label, response, expected) => {
    const env = await ready(setup({ session: stored(1) }));
    env.routes["POST /api/v1/auth/password"] = response;
    await expect(
      env.client.changePassword("old-password", "new password 123")
    ).rejects.toMatchObject(expected);
    expect(env.client.getSnapshot()).toEqual(signedIn);
  });

  it("refreshes once when an account action meets an expired access token", async () => {
    const env = await ready(setup({ session: stored(1) }));
    env.routes["POST /api/v1/auth/password"] = ({ headers }) =>
      headers.get("authorization") === "Bearer orch_sess_2"
        ? new Response(null, { status: 204 })
        : apiError(401, "UNAUTHENTICATED");
    env.routes["POST /api/v1/auth/refresh"] = () => json(200, sessionBody(2));
    await env.client.changePassword("old-password", "new password 123");
    expect(env.calls.map((call) => call.key)).toEqual([
      "POST /api/v1/auth/password",
      "POST /api/v1/auth/refresh",
      "POST /api/v1/auth/password"
    ]);
  });

  it("expires the session when an account action is rejected twice", async () => {
    const env = await ready(setup({ session: stored(1) }));
    env.routes["POST /api/v1/auth/logout-all"] = () =>
      apiError(401, "UNAUTHENTICATED");
    env.routes["POST /api/v1/auth/refresh"] = () => json(200, sessionBody(2));
    await expect(env.client.signOutEverywhere()).rejects.toMatchObject({
      code: "UNAUTHENTICATED"
    });
    expect(env.client.getSnapshot()).toEqual({ status: "signedOut" });
  });
});
