import assert from "node:assert/strict";
import test from "node:test";
import type { HumanAuth } from "@orchestrat/auth";
import type { Database } from "@orchestrat/db";
import {
  agentCredentials,
  agents,
  cliCredentials,
  organizationMembers,
  users
} from "@orchestrat/db";
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
    const secretOnApprove = await app.inject({
      method: "POST",
      url: `/api/v1/cli/authorization/attempts/${attempt.attempt_id}/approve`,
      headers: { authorization: "Bearer alice" },
      payload: { project_id: project.id, secret: attempt.secret }
    });
    assert.equal(secretOnApprove.statusCode, 400);
    const unknownOnDeny = await app.inject({
      method: "POST",
      url: `/api/v1/cli/authorization/attempts/${attempt.attempt_id}/deny`,
      headers: { authorization: "Bearer alice" },
      payload: { unknown: true }
    });
    assert.equal(unknownOnDeny.statusCode, 400);
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/cli/authorization/attempts/${attempt.attempt_id}/deny`,
      headers: { authorization: "Bearer alice" },
      payload: {}
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
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/cli/authorization/attempts/${unauthorisedAttempt.attempt_id}/approve`,
      headers: { authorization: "Bearer alice" },
      payload: {}
    });
    assert.equal(approved.statusCode, 200);
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

test("CLI disconnect request is strict at the trust boundary", async () => {
  const { app } = await fixture();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup/disconnect",
      headers: { authorization: "Bearer nope" },
      payload: {
        project_id: "550e8400-e29b-41d4-a716-446655440000",
        agent_ids: ["550e8400-e29b-41d4-a716-446655440001"],
        revoke_cli: false,
        extra: "rejected"
      }
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "VALIDATION_ERROR");
  } finally {
    await app.close();
  }
});

test("approved attempts expire without issuing credentials and exchange only once", async () => {
  const { app, db } = await fixture();
  let now = new Date("2026-08-22T00:00:00.000Z");
  const service = new CliAuthorizationService(db, () => now);
  try {
    await db.insert(users).values({
      authProvider: "supabase",
      authSubject: "550e8400-e29b-41d4-a716-446655440000",
      username: "alice",
      name: "alice",
      email: "alice@example.com"
    });
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, "alice@example.com"));
    assert.ok(user);
    const expiring = await service.createAttempt();
    await service.approve(user.id, expiring.attempt_id);
    now = new Date(now.getTime() + 10 * 60_000 + 1);
    assert.deepEqual(await service.poll(expiring.attempt_id, expiring.secret), {
      status: "expired"
    });
    assert.equal((await db.select().from(cliCredentials)).length, 0);

    now = new Date("2026-08-22T00:00:00.000Z");
    const exchange = await service.createAttempt();
    await service.approve(user.id, exchange.attempt_id);
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
    assert.equal(rows[0]!.projectId, null);
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
    const cursor = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup",
      headers: { authorization: `Bearer ${token}` },
      payload: { project_id: project.id, integration: "cursor" }
    });
    assert.equal(codex.statusCode, 200);
    assert.equal(claude.statusCode, 200);
    assert.equal(cursor.statusCode, 200);
    assert.notEqual(codex.json().agent.id, claude.json().agent.id);
    assert.notEqual(cursor.json().agent.id, claude.json().agent.id);
    assert.match(codex.json().credential.token, /^orch_agent_/);
    assert.match(claude.json().credential.token, /^orch_agent_/);
    assert.notEqual(
      codex.json().credential.token,
      claude.json().credential.token
    );
    assert.equal((await db.query.cliCredentials.findMany()).length, 1);
    assert.equal((await db.query.agentCredentials.findMany()).length, 3);
    await app.inject({
      method: "GET",
      url: "/api/v1/profile",
      headers: { authorization: "Bearer bob" }
    });
    const bob = (
      await db.select().from(users).where(eq(users.email, "bob@example.com"))
    )[0]!;
    await db.insert(organizationMembers).values({
      organizationId: org.id,
      userId: bob.id,
      role: "member"
    });
    const addedOwner = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/members`,
      headers: { authorization: "Bearer alice" },
      payload: { user_id: bob.id, role: "owner" }
    });
    assert.equal(addedOwner.statusCode, 201);
    const removedAlice = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}/members/${user.id}`,
      headers: { authorization: "Bearer bob" }
    });
    assert.equal(removedAlice.statusCode, 200);
    const removedProject = await app.inject({
      method: "GET",
      url: "/api/v1/cli/setup/project",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(removedProject.statusCode, 403);
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

test("user-scoped CLI credentials list and configure accessible projects", async () => {
  const { app, db } = await fixture();
  try {
    const organization = (
      await app.inject({
        method: "POST",
        url: "/api/v1/organizations",
        headers: { authorization: "Bearer alice" },
        payload: { name: "CLI projects" }
      })
    ).json();
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organization.id}/projects`,
        headers: { authorization: "Bearer alice" },
        payload: { name: "Chosen in CLI" }
      })
    ).json();
    const token = `orch_cli_${"u".repeat(32)}`;
    const user = (await db.query.users.findFirst())!;
    await db.insert(cliCredentials).values({
      userId: user.id,
      tokenHash: createHash("sha256").update(token).digest("hex")
    });
    const projects = await app.inject({
      method: "GET",
      url: "/api/v1/cli/setup/projects",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(projects.statusCode, 200);
    assert.deepEqual(projects.json().projects, [
      {
        id: project.id,
        name: "Chosen in CLI",
        organization_name: "CLI projects"
      }
    ]);
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup",
      headers: { authorization: `Bearer ${token}` },
      payload: { project_id: project.id, integration: "cursor" }
    });
    assert.equal(setup.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("CLI disconnect is project-scoped and revokes selected then final agents", async () => {
  const { app, db } = await fixture();
  try {
    const org = (
      await app.inject({
        method: "POST",
        url: "/api/v1/organizations",
        headers: { authorization: "Bearer alice" },
        payload: { name: "Disconnect" }
      })
    ).json();
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${org.id}/projects`,
        headers: { authorization: "Bearer alice" },
        payload: { name: "Project" }
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
    const token = `orch_cli_${"d".repeat(32)}`;
    const user = (await db.query.users.findFirst())!;
    await db.insert(cliCredentials).values({
      projectId: project.id,
      userId: user.id,
      tokenHash: createHash("sha256").update(token).digest("hex")
    });
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup",
      headers: { authorization: `Bearer ${token}` },
      payload: { project_id: project.id, integration: "codex" }
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup",
      headers: { authorization: `Bearer ${token}` },
      payload: { project_id: project.id, integration: "claude-code" }
    });
    const firstId = first.json().agent.id;
    const secondId = second.json().agent.id;
    const otherToken = `orch_cli_${"o".repeat(32)}`;
    await db.insert(cliCredentials).values({
      projectId: other.id,
      userId: user.id,
      tokenHash: createHash("sha256").update(otherToken).digest("hex")
    });
    const foreign = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup",
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { project_id: other.id, integration: "codex" }
    });
    const foreignId = foreign.json().agent.id;
    const mixed = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup/disconnect",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        project_id: project.id,
        agent_ids: [firstId, foreignId],
        revoke_cli: false
      }
    });
    assert.equal(mixed.statusCode, 404);
    assert.equal(
      (await db.select().from(agents).where(eq(agents.id, firstId)))[0]!.status,
      "active"
    );
    assert.equal(
      (
        await db
          .select()
          .from(agentCredentials)
          .where(eq(agentCredentials.agentId, firstId))
      ).every((row) => row.revokedAt === null),
      true
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/cli/setup/project",
          headers: { authorization: `Bearer ${token}` }
        })
      ).statusCode,
      200
    );
    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup/disconnect",
      headers: { authorization: `Bearer ${token}` },
      payload: { project_id: other.id, agent_ids: [firstId], revoke_cli: false }
    });
    assert.equal(wrong.statusCode, 403);
    const partial = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup/disconnect",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        project_id: project.id,
        agent_ids: [firstId],
        revoke_cli: false
      }
    });
    assert.equal(partial.statusCode, 200);
    assert.deepEqual(partial.json(), {
      project_id: project.id,
      revoked_agent_ids: [firstId],
      cli_revoked: false
    });
    assert.doesNotMatch(JSON.stringify(partial.json()), /orch_/);
    assert.equal(
      (await db.select().from(agents).where(eq(agents.id, firstId)))[0]!.status,
      "revoked"
    );
    assert.equal(
      (await db.select().from(agents).where(eq(agents.id, secondId)))[0]!
        .status,
      "active"
    );
    assert.equal(
      (
        await db
          .select()
          .from(agentCredentials)
          .where(eq(agentCredentials.agentId, firstId))
      ).every((row) => row.revokedAt !== null),
      true
    );
    assert.equal(
      (
        await db
          .select()
          .from(agentCredentials)
          .where(eq(agentCredentials.agentId, secondId))
      ).every((row) => row.revokedAt === null),
      true
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/cli/setup/project",
          headers: { authorization: `Bearer ${token}` }
        })
      ).statusCode,
      200
    );
    const final = await app.inject({
      method: "POST",
      url: "/api/v1/cli/setup/disconnect",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        project_id: project.id,
        agent_ids: [secondId],
        revoke_cli: true
      }
    });
    assert.equal(final.statusCode, 200);
    assert.deepEqual(final.json(), {
      project_id: project.id,
      revoked_agent_ids: [secondId],
      cli_revoked: true
    });
    assert.doesNotMatch(JSON.stringify(final.json()), /orch_/);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/cli/setup/project",
          headers: { authorization: `Bearer ${token}` }
        })
      ).statusCode,
      401
    );
    assert.equal(
      (
        await db
          .select()
          .from(agentCredentials)
          .where(eq(agentCredentials.agentId, firstId))
      ).every((row) => row.revokedAt !== null),
      true
    );
  } finally {
    await app.close();
  }
});
