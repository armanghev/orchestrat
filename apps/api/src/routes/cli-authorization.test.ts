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
