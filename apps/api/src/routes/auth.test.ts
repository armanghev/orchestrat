import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  authSessions,
  cliCredentials,
  projectMembers,
  users
} from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
import { clientKey } from "../services/rate-limit.js";
import { TEST_SETUP_TOKEN, fixture } from "../test/fixture.js";

type App = Awaited<ReturnType<typeof fixture>>["app"];

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const password = "correct horse battery";

const signup = (app: App, email: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/api/v1/auth/signup",
    payload: {
      email,
      password,
      full_name: email.split("@")[0],
      setup_token: TEST_SETUP_TOKEN,
      ...extra
    }
  });

const login = (app: App, email: string, secret = password) =>
  app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password: secret }
  });

// Changes the last character to a different one (a fixed replacement would
// match the original 1 time in 64).
const tampered = (token: string) =>
  `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

const profile = (app: App, token: string) =>
  app.inject({ method: "GET", url: "/api/v1/profile", headers: bearer(token) });

test("the first account on an empty instance becomes its admin", async () => {
  const { app } = await fixture({ builtinAuth: true });

  const before = await app.inject({
    method: "GET",
    url: "/api/v1/auth/instance"
  });
  assert.deepEqual(before.json(), { needs_setup: true, signup_mode: "invite" });

  // Claiming an empty instance needs the setup token from the server log.
  for (const setup_token of [undefined, "wrong-token-0123456789"]) {
    const refused = await signup(app, "mallory@example.com", { setup_token });
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().error.code, "SETUP_TOKEN_REQUIRED");
  }

  const first = await signup(app, "Ada@Example.com ");
  assert.equal(first.statusCode, 201);
  assert.equal(first.headers["cache-control"], "no-store");
  const session = first.json();
  assert.match(session.access_token, /^orch_sess_[A-Za-z0-9_-]{43}$/);
  assert.match(session.refresh_token, /^orch_refresh_[A-Za-z0-9_-]{43}$/);
  assert.equal(session.token_type, "Bearer");
  assert.equal(session.expires_in, 3600);
  assert.equal(session.user.email, "ada@example.com");
  assert.equal(session.user.is_instance_admin, true);

  const me = await profile(app, session.access_token);
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().email, "ada@example.com");
  assert.equal(me.json().provider, "local");
  assert.equal(me.json().is_instance_admin, true);

  const after = await app.inject({
    method: "GET",
    url: "/api/v1/auth/instance"
  });
  assert.equal(after.json().needs_setup, false);
});

test("invite mode needs a usable project invite link, and sign-up uses it up", async () => {
  const { app, db } = await fixture({ builtinAuth: true });
  const admin = (await signup(app, "ada@example.com")).json();

  const missing = await signup(app, "bob@example.com");
  assert.equal(missing.statusCode, 403);
  assert.equal(missing.json().error.code, "INVITE_REQUIRED");

  const bogus = await signup(app, "bob@example.com", {
    invite_token: "not-a-real-invite"
  });
  assert.equal(bogus.statusCode, 403);
  assert.equal(bogus.json().error.code, "INVITE_REQUIRED");

  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: bearer(admin.access_token),
      payload: { name: "Acme" }
    })
  ).json();
  const project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organization.id}/projects`,
      headers: bearer(admin.access_token),
      payload: { name: "Rocket" }
    })
  ).json();
  const invite = (
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/invitations`,
      headers: bearer(admin.access_token)
    })
  ).json();

  const invited = await signup(app, "bob@example.com", {
    invite_token: invite.token
  });
  assert.equal(invited.statusCode, 201);
  assert.equal(invited.json().user.is_instance_admin, false);
  assert.equal(invited.json().invited_project_id, project.id);
  const [membership] = await db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, project.id),
        eq(projectMembers.userId, invited.json().user.user_id)
      )
    );
  assert.equal(membership?.role, "member");

  const accepted = await app.inject({
    method: "POST",
    url: "/api/v1/project-invitations/accept",
    headers: bearer(invited.json().access_token),
    payload: { token: invite.token }
  });
  assert.equal(accepted.statusCode, 200);

  // A used invite no longer opens signup.
  const reused = await signup(app, "carol@example.com", {
    invite_token: invite.token
  });
  assert.equal(reused.statusCode, 403);
});

test("closed and open signup modes", async () => {
  const closed = (await fixture({ builtinAuth: true, signupMode: "closed" }))
    .app;
  assert.equal((await signup(closed, "ada@example.com")).statusCode, 201);
  const refused = await signup(closed, "bob@example.com");
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().error.code, "SIGNUP_CLOSED");

  const open = (await fixture({ builtinAuth: true, signupMode: "open" })).app;
  assert.equal((await signup(open, "ada@example.com")).statusCode, 201);
  const second = await signup(open, "bob@example.com");
  assert.equal(second.statusCode, 201);
  assert.equal(second.json().user.is_instance_admin, false);
  const duplicate = await signup(open, "BOB@example.com");
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error.code, "EMAIL_TAKEN");
});

test("signup validates email, password length and name", async () => {
  const { app } = await fixture({ builtinAuth: true });
  for (const payload of [
    { email: "not-an-email", password, full_name: "Ada" },
    { email: "ada@example.com", password: "short", full_name: "Ada" },
    { email: "ada@example.com", password, full_name: "  " }
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signup",
      payload
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
});

test("login checks the password and gives the same error for unknown emails", async () => {
  const { app } = await fixture({ builtinAuth: true });
  await signup(app, "ada@example.com");

  const wrong = await login(app, "ada@example.com", "wrong password!!");
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error.code, "INVALID_CREDENTIALS");
  const unknown = await login(app, "nobody@example.com");
  assert.equal(unknown.statusCode, 401);
  assert.deepEqual(
    { ...unknown.json().error, request_id: "" },
    { ...wrong.json().error, request_id: "" }
  );

  const ok = await login(app, " ADA@example.com");
  assert.equal(ok.statusCode, 200);
  assert.equal((await profile(app, ok.json().access_token)).statusCode, 200);
});

test("refresh rotates both tokens; a stale refresh token in the grace window does not end the session", async () => {
  const { app } = await fixture({ builtinAuth: true });
  const first = (await signup(app, "ada@example.com")).json();

  const refreshed = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refresh_token: first.refresh_token }
  });
  assert.equal(refreshed.statusCode, 200);
  const second = refreshed.json();
  assert.notEqual(second.access_token, first.access_token);
  assert.notEqual(second.refresh_token, first.refresh_token);
  assert.equal((await profile(app, first.access_token)).statusCode, 401);
  assert.equal((await profile(app, second.access_token)).statusCode, 200);

  // Another tab presents the old refresh token right after the rotation.
  const raced = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refresh_token: first.refresh_token }
  });
  assert.equal(raced.statusCode, 401);
  assert.equal(raced.json().error.code, "REFRESH_TOKEN_INVALID");
  assert.equal((await profile(app, second.access_token)).statusCode, 200);
});

test("reusing a rotated refresh token after the grace window ends the session", async () => {
  const { app } = await fixture({
    builtinAuth: true,
    sessionAuth: { refreshReuseGraceSeconds: 0 }
  });
  const first = (await signup(app, "ada@example.com")).json();
  const second = (
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refresh_token: first.refresh_token }
    })
  ).json();

  const replayed = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refresh_token: first.refresh_token }
  });
  assert.equal(replayed.statusCode, 401);
  assert.equal((await profile(app, second.access_token)).statusCode, 401);
  const stillDead = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refresh_token: second.refresh_token }
  });
  assert.equal(stillDead.statusCode, 401);
});

test("expired access tokens are refused", async () => {
  const { app } = await fixture({
    builtinAuth: true,
    sessionAuth: { accessTtlSeconds: -1 }
  });
  const session = (await signup(app, "ada@example.com")).json();
  assert.equal((await profile(app, session.access_token)).statusCode, 401);
});

test("logout ends this session; logout-all ends every session", async () => {
  const { app } = await fixture({ builtinAuth: true });
  const a = (await signup(app, "ada@example.com")).json();
  const b = (await login(app, "ada@example.com")).json();
  const c = (await login(app, "ada@example.com")).json();

  const out = await app.inject({
    method: "POST",
    url: "/api/v1/auth/logout",
    headers: bearer(a.access_token)
  });
  assert.equal(out.statusCode, 204);
  assert.equal((await profile(app, a.access_token)).statusCode, 401);
  assert.equal((await profile(app, b.access_token)).statusCode, 200);

  const all = await app.inject({
    method: "POST",
    url: "/api/v1/auth/logout-all",
    headers: bearer(b.access_token)
  });
  assert.equal(all.statusCode, 204);
  assert.equal((await profile(app, b.access_token)).statusCode, 401);
  assert.equal((await profile(app, c.access_token)).statusCode, 401);
  const refresh = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refresh_token: c.refresh_token }
  });
  assert.equal(refresh.statusCode, 401);
});

test("changing the password keeps this session and ends the others", async () => {
  const { app } = await fixture({ builtinAuth: true });
  const current = (await signup(app, "ada@example.com")).json();
  const other = (await login(app, "ada@example.com")).json();

  const wrong = await app.inject({
    method: "POST",
    url: "/api/v1/auth/password",
    headers: bearer(current.access_token),
    payload: {
      current_password: "not the password",
      new_password: "a brand new passphrase"
    }
  });
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.json().error.code, "PASSWORD_INCORRECT");

  const changed = await app.inject({
    method: "POST",
    url: "/api/v1/auth/password",
    headers: bearer(current.access_token),
    payload: {
      current_password: password,
      new_password: "a brand new passphrase"
    }
  });
  assert.equal(changed.statusCode, 204);
  assert.equal((await profile(app, current.access_token)).statusCode, 200);
  assert.equal((await profile(app, other.access_token)).statusCode, 401);
  assert.equal((await login(app, "ada@example.com")).statusCode, 401);
  assert.equal(
    (await login(app, "ada@example.com", "a brand new passphrase")).statusCode,
    200
  );
});

test("only access tokens work on signed-in routes", async () => {
  const { app } = await fixture({ builtinAuth: true });
  const session = (await signup(app, "ada@example.com")).json();
  assert.equal((await profile(app, session.refresh_token)).statusCode, 401);
  assert.equal((await profile(app, "alice")).statusCode, 401);
  assert.equal(
    (await profile(app, tampered(session.access_token))).statusCode,
    401
  );
  const agentToken = await profile(app, `orch_agent_${"a".repeat(43)}`);
  assert.equal(agentToken.statusCode, 401);
  assert.equal(agentToken.json().error.code, "AGENT_CREDENTIAL_INVALID");
});

test("sessions store only token hashes", async () => {
  const { app, db } = await fixture({ builtinAuth: true });
  const session = (await signup(app, "ada@example.com")).json();
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, "ada@example.com"));
  const rows = await db
    .select()
    .from(authSessions)
    .where(eq(authSessions.userId, user!.id));
  assert.equal(rows.length, 1);
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes(session.access_token), false);
  assert.equal(serialized.includes(session.refresh_token), false);
});

test("only failed logins count toward the per-email limit", async () => {
  const { app } = await fixture({
    builtinAuth: true,
    rateLimits: { authLoginPerEmail: 2 }
  });
  await signup(app, "ada@example.com");
  for (let attempt = 0; attempt < 3; attempt += 1)
    assert.equal((await login(app, "ada@example.com")).statusCode, 200);
  assert.equal(
    (await login(app, "ada@example.com", "wrong one!!")).statusCode,
    401
  );
  assert.equal(
    (await login(app, "ada@example.com", "wrong two!!")).statusCode,
    401
  );
  const limited = await login(app, "ADA@example.com");
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "RATE_LIMITED");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal((await login(app, "someone@example.com")).statusCode, 401);
});
test("an invite can't open two accounts", async () => {
  const { app } = await fixture({ builtinAuth: true, signupMode: "open" });
  const admin = (await signup(app, "ada@example.com")).json();
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: bearer(admin.access_token),
      payload: { name: "Acme" }
    })
  ).json();
  const project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organization.id}/projects`,
      headers: bearer(admin.access_token),
      payload: { name: "Rocket" }
    })
  ).json();
  const invite = (
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/invitations`,
      headers: bearer(admin.access_token)
    })
  ).json();
  assert.equal(
    (await signup(app, "bob@example.com", { invite_token: invite.token }))
      .statusCode,
    201
  );
  const second = await signup(app, "carol@example.com", {
    invite_token: invite.token
  });
  assert.equal(second.statusCode, 403);
  assert.equal(second.json().error.code, "INVITE_REQUIRED");
  // pg-mem ignores ROLLBACK; auth-postgres.integration.test.ts checks that
  // the refused sign-up leaves no account behind.
});

test("closed and invite modes refuse before revealing whether an email exists", async () => {
  const { app } = await fixture({ builtinAuth: true, signupMode: "closed" });
  await signup(app, "ada@example.com");
  const existing = await signup(app, "ada@example.com");
  const fresh = await signup(app, "zed@example.com");
  assert.equal(existing.statusCode, 403);
  assert.equal(fresh.statusCode, 403);
  assert.equal(existing.json().error.code, fresh.json().error.code);
});

test("revoke ends a session with only its refresh token", async () => {
  const { app } = await fixture({ builtinAuth: true });
  const session = (await signup(app, "ada@example.com")).json();
  const revoked = await app.inject({
    method: "POST",
    url: "/api/v1/auth/revoke",
    payload: { refresh_token: session.refresh_token }
  });
  assert.equal(revoked.statusCode, 204);
  assert.equal((await profile(app, session.access_token)).statusCode, 401);
  const unknown = await app.inject({
    method: "POST",
    url: "/api/v1/auth/revoke",
    payload: { refresh_token: `orch_refresh_${"x".repeat(43)}` }
  });
  assert.equal(unknown.statusCode, 204);
});

test("sessions end 90 days after sign-in however often they refresh", async () => {
  const { app } = await fixture({
    builtinAuth: true,
    sessionAuth: { sessionMaxAgeSeconds: 0 }
  });
  const session = (await signup(app, "ada@example.com")).json();
  const refreshed = await app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refresh_token: session.refresh_token }
  });
  assert.equal(refreshed.statusCode, 401);
});

test("password changes are rate limited per user", async () => {
  const { app } = await fixture({
    builtinAuth: true,
    rateLimits: { authPassword: 2 }
  });
  const session = (await signup(app, "ada@example.com")).json();
  const attempt = () =>
    app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: bearer(session.access_token),
      payload: {
        current_password: "guess number one",
        new_password: "a brand new passphrase"
      }
    });
  assert.equal((await attempt()).statusCode, 403);
  assert.equal((await attempt()).statusCode, 403);
  assert.equal((await attempt()).statusCode, 429);
});

test("signing out everywhere and password changes revoke CLI credentials", async () => {
  const { app, db } = await fixture({ builtinAuth: true });
  const session = (await signup(app, "ada@example.com")).json();
  const insertCliCredential = async () => {
    const [row] = await db
      .insert(cliCredentials)
      .values({
        userId: session.user.user_id,
        tokenHash: randomUUID()
      })
      .returning();
    return row!.id;
  };
  const revokedAt = async (id: string) =>
    (await db.select().from(cliCredentials).where(eq(cliCredentials.id, id)))[0]
      ?.revokedAt;

  const first = await insertCliCredential();
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/password",
    headers: bearer(session.access_token),
    payload: {
      current_password: password,
      new_password: "a brand new passphrase"
    }
  });
  assert.ok(await revokedAt(first));

  const second = await insertCliCredential();
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/logout-all",
    headers: bearer(session.access_token)
  });
  assert.ok(await revokedAt(second));
});

test("rate limits group IPv6 clients by /64", () => {
  assert.equal(clientKey("203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(clientKey("2001:db8:1:2::ffff"), "2001:db8:1:2::/64");
  assert.equal(clientKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKey("::1"), "0:0:0:0::/64");
});
