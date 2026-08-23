import assert from "node:assert/strict";
import test from "node:test";
import type { HumanAuth } from "@orchestrat/auth";
import type { Database } from "@orchestrat/db";
import { cliCredentials, users } from "@orchestrat/db";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { fixture } from "../test/fixture.js";
import { CliAuthorizationService } from "../services/cli-authorization-service.js";
import { createHash } from "node:crypto";

test("CLI authorization rejects missing secrets with a validation error", async () => {
  const auth: HumanAuth = {
    async authenticate() {
      return null;
    }
  };
  const app = buildApp({ allowedOrigins: [], auth, db: {} as Database });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cli/authorization/attempts/ca_12345678901234567890/poll",
      payload: { secret: 42 }
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "VALIDATION_ERROR");
  } finally {
    await app.close();
  }
});

test("CLI authorization stores only hashes, denies access, expires, and exchanges once", async () => {
  const { app, db } = await fixture();
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/cli/authorization/attempts"
    });
    assert.equal(created.statusCode, 201);
    const attempt = created.json();
    const organizations = (
      await app.inject({
        method: "POST",
        url: "/api/v1/organizations",
        headers: { authorization: "Bearer alice" },
        payload: { name: "Auth" }
      })
    ).json();
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organizations.id}/projects`,
        headers: { authorization: "Bearer alice" },
        payload: { name: "Project" }
      })
    ).json();
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/cli/authorization/attempts/${attempt.attempt_id}/deny`,
      headers: { authorization: "Bearer alice" },
      payload: { secret: attempt.secret }
    });
    assert.equal(denied.statusCode, 200);
    const deniedPoll = await app.inject({
      method: "POST",
      url: `/api/v1/cli/authorization/attempts/${attempt.attempt_id}/poll`,
      payload: { secret: attempt.secret }
    });
    assert.equal(deniedPoll.json().status, "denied");
    const stored = await db.query.cliAuthorizationAttempts.findFirst();
    assert.ok(stored);
    assert.notEqual(stored.secretHash, attempt.secret);
    const unauthorisedAttempt = (
      await app.inject({
        method: "POST",
        url: "/api/v1/cli/authorization/attempts"
      })
    ).json();
    const deniedApproval = await app.inject({
      method: "POST",
      url: `/api/v1/cli/authorization/attempts/${unauthorisedAttempt.attempt_id}/approve`,
      headers: { authorization: "Bearer alice" },
      payload: {
        secret: unauthorisedAttempt.secret,
        project_id: "00000000-0000-4000-8000-000000000000"
      }
    });
    assert.equal(deniedApproval.statusCode, 403);
    assert.ok(project.id);
  } finally {
    await app.close();
  }
});

test("CLI setup rejects malformed credentials and unsupported integrations", async () => {
  const { app } = await fixture();
  try {
    const malformed = await app.inject({
      method: "GET",
      url: "/api/v1/cli/setup/project",
      headers: { authorization: "Bearer nope" }
    });
    assert.equal(malformed.statusCode, 401);
    const unsupported = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup",
      headers: { authorization: "Bearer nope" },
      payload: {
        project_id: "550e8400-e29b-41d4-a716-446655440000",
        integration: "other"
      }
    });
    assert.equal(unsupported.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("approved attempts expire without issuing credentials and exchange only once", async () => {
  const { app, db } = await fixture();
  let now = new Date("2026-08-22T00:00:00.000Z");
  const service = new CliAuthorizationService(db, () => now);
  try {
    const org = (
      await app.inject({
        method: "POST",
        url: "/api/v1/organizations",
        headers: { authorization: "Bearer alice" },
        payload: { name: "Expiry" }
      })
    ).json();
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${org.id}/projects`,
        headers: { authorization: "Bearer alice" },
        payload: { name: "Expiry project" }
      })
    ).json();
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, "alice@example.com"));
    assert.ok(user);
    const expiring = await service.createAttempt();
    await service.approve(
      user.id,
      expiring.attempt_id,
      expiring.secret,
      project.id
    );
    now = new Date(now.getTime() + 10 * 60_000 + 1);
    assert.deepEqual(await service.poll(expiring.attempt_id, expiring.secret), {
      status: "expired"
    });
    assert.equal((await db.select().from(cliCredentials)).length, 0);

    now = new Date("2026-08-22T00:00:00.000Z");
    const exchange = await service.createAttempt();
    await service.approve(
      user.id,
      exchange.attempt_id,
      exchange.secret,
      project.id
    );
    const first = await service.poll(exchange.attempt_id, exchange.secret);
    assert.equal(first.status, "approved");
    assert.match(first.credential!, /^orch_cli_/);
    now = new Date(now.getTime() + 2_001);
    await assert.rejects(
      () => service.poll(exchange.attempt_id, exchange.secret),
      /already exchanged/
    );
    const rows = await db.select().from(cliCredentials);
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]!.tokenHash,
      createHash("sha256").update(first.credential!).digest("hex")
    );
    assert.notEqual(rows[0]!.tokenHash, first.credential);
  } finally {
    await app.close();
  }
});

test("CLI setup enforces token and project scope and issues distinct agent credentials", async () => {
  const { app, db } = await fixture();
  try {
    const org = (
      await app.inject({
        method: "POST",
        url: "/api/v1/organizations",
        headers: { authorization: "Bearer alice" },
        payload: { name: "Setup" }
      })
    ).json();
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${org.id}/projects`,
        headers: { authorization: "Bearer alice" },
        payload: { name: "Setup project" }
      })
    ).json();
    const other = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${org.id}/projects`,
        headers: { authorization: "Bearer alice" },
        payload: { name: "Other" }
      })
    ).json();
    const token = "orch_cli_" + "x".repeat(32);
    const user = (await db.query.users.findFirst())!;
    await db.insert(cliCredentials).values({
      projectId: project.id,
      userId: user.id,
      tokenHash: createHash("sha256").update(token).digest("hex")
    });
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup",
      headers: { authorization: `Bearer ${token}` },
      payload: { project_id: other.id, integration: "codex" }
    });
    assert.equal(denied.statusCode, 403);
    const codex = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup",
      headers: { authorization: `Bearer ${token}` },
      payload: { project_id: project.id, integration: "codex" }
    });
    const claude = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup",
      headers: { authorization: `Bearer ${token}` },
      payload: { project_id: project.id, integration: "claude-code" }
    });
    assert.equal(codex.statusCode, 200);
    assert.equal(claude.statusCode, 200);
    assert.notEqual(codex.json().agent.id, claude.json().agent.id);
    assert.match(codex.json().credential.token, /^orch_agent_/);
    assert.match(claude.json().credential.token, /^orch_agent_/);
    assert.notEqual(
      codex.json().credential.token,
      claude.json().credential.token
    );
    assert.equal((await db.query.cliCredentials.findMany()).length, 1);
    assert.equal((await db.query.agentCredentials.findMany()).length, 2);
    await db.update(cliCredentials).set({ revokedAt: new Date() });
    const revokedProject = await app.inject({
      method: "GET",
      url: "/api/v1/cli/setup/project",
      headers: { authorization: `Bearer ${token}` }
    });
    const revokedSetup = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup",
      headers: { authorization: `Bearer ${token}` },
      payload: { project_id: project.id, integration: "codex" }
    });
    assert.equal(revokedProject.statusCode, 401);
    assert.equal(revokedSetup.statusCode, 401);
  } finally {
    await app.close();
  }
});
