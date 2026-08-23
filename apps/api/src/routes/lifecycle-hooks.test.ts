import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  agentLifecycleEvents,
  projectEvents,
  taskClaims,
  tasks
} from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
import { fixture } from "../test/fixture.js";

const human = { authorization: "Bearer alice" };

test("agent lifecycle hooks are scoped, durable, idempotent, and task-neutral", async () => {
  const { app, db } = await fixture();
  try {
    const organization = (
      await app.inject({
        method: "POST",
        url: "/api/v1/organizations",
        headers: human,
        payload: { name: "Lifecycle org" }
      })
    ).json();
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organization.id}/projects`,
        headers: human,
        payload: { name: "Lifecycle project" }
      })
    ).json();
    const agent = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents`,
        headers: human,
        payload: { name: "codex" }
      })
    ).json();
    const credential = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents/${agent.id}/credentials`,
        headers: human
      })
    ).json();
    const task = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/tasks`,
        headers: { ...human, "idempotency-key": "lifecycle-task" },
        payload: { title: "Must remain unchanged", status: "ready" }
      })
    ).json();
    const tokenHeaders = {
      authorization: `Bearer ${credential.token}`,
      "idempotency-key": "hook-start-1"
    };
    const sessionId = randomUUID();
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/agent/hooks/lifecycle",
      headers: { authorization: `Bearer ${credential.token}` },
      payload: {
        event: "session.started",
        session_id: sessionId,
        runtime: "codex",
        integration: "codex",
        project_id: randomUUID()
      }
    });
    assert.equal(invalid.statusCode, 400);
    const unsupported = await app.inject({
      method: "POST",
      url: "/api/v1/agent/hooks/lifecycle",
      headers: {
        authorization: `Bearer ${credential.token}`,
        "idempotency-key": "hook-unsupported"
      },
      payload: {
        event: "session.stopped",
        session_id: randomUUID(),
        runtime: "codex",
        integration: "codex"
      }
    });
    assert.equal(unsupported.statusCode, 400);

    const concurrentStarts = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: "POST",
          url: "/api/v1/agent/hooks/lifecycle",
          headers: tokenHeaders,
          payload: {
            event: "session.started",
            session_id: sessionId,
            runtime: "codex",
            integration: "codex"
          }
        })
      )
    );
    assert.deepEqual(
      concurrentStarts.map((response) => response.statusCode),
      [200, 200]
    );
    assert.equal(
      concurrentStarts[0]!.json().event_id,
      concurrentStarts[1]!.json().event_id
    );
    const started = concurrentStarts[0]!;
    assert.equal(started.statusCode, 200);
    assert.equal(started.json().session.status, "active");
    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/agent/hooks/lifecycle",
      headers: tokenHeaders,
      payload: {
        event: "session.started",
        session_id: sessionId,
        runtime: "codex",
        integration: "codex"
      }
    });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().event_id, started.json().event_id);
    const differentBody = await app.inject({
      method: "POST",
      url: "/api/v1/agent/hooks/lifecycle",
      headers: tokenHeaders,
      payload: {
        event: "session.started",
        session_id: sessionId,
        runtime: "codex",
        integration: "codex",
        error: "different normalized body"
      }
    });
    assert.equal(differentBody.statusCode, 409);
    assert.equal(differentBody.json().error.code, "IDEMPOTENCY_CONFLICT");
    const claim = await app.inject({
      method: "POST",
      url: `/api/v1/agent/tasks/${task.id}/claim`,
      headers: { authorization: `Bearer ${credential.token}` },
      payload: { session_id: sessionId, lease_seconds: 300 }
    });
    assert.equal(claim.statusCode, 200);

    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/agent/hooks/lifecycle",
      headers: {
        authorization: `Bearer ${credential.token}`,
        "idempotency-key": "hook-fail-1"
      },
      payload: {
        event: "run.failed",
        session_id: sessionId,
        runtime: "codex",
        integration: "codex",
        error: "bounded failure detail"
      }
    });
    assert.equal(failed.statusCode, 200);
    assert.equal(failed.json().session.status, "active");
    const failedTask = (
      await db.select().from(tasks).where(eq(tasks.id, task.id))
    )[0]!;
    assert.equal(failedTask.status, "claimed");
    const activeClaim = (
      await db.select().from(taskClaims).where(eq(taskClaims.taskId, task.id))
    )[0]!;
    assert.equal(activeClaim.status, "active");
    assert.equal(activeClaim.completedAt, null);

    const ended = await app.inject({
      method: "POST",
      url: "/api/v1/agent/hooks/lifecycle",
      headers: {
        authorization: `Bearer ${credential.token}`,
        "idempotency-key": "hook-end-1"
      },
      payload: {
        event: "session.ended",
        session_id: sessionId,
        runtime: "codex",
        integration: "codex"
      }
    });
    assert.equal(ended.statusCode, 200);
    assert.equal(ended.json().session.status, "closed");
    const eventRows = await db
      .select()
      .from(projectEvents)
      .where(
        and(
          eq(projectEvents.projectId, project.id),
          eq(projectEvents.actorAgentId, agent.id)
        )
      );
    assert.equal(
      eventRows.filter((event) => event.type === "session.started").length,
      1
    );
    assert.equal(
      eventRows.filter((event) => event.type === "session.ended").length,
      1
    );
    assert.equal(
      eventRows.filter((event) => event.type === "run.failed").length,
      1
    );
    assert.equal((await db.select().from(agentLifecycleEvents)).length, 3);
    const storedTask = (
      await db.select().from(tasks).where(eq(tasks.id, task.id))
    )[0]!;
    assert.equal(storedTask.status, "ready");
    assert.equal(storedTask.version, 3);
    const endedClaim = (
      await db
        .select()
        .from(taskClaims)
        .where(eq(taskClaims.id, claim.json().claim.id))
    )[0]!;
    assert.notEqual(endedClaim.status, "completed");
    assert.equal(endedClaim.completedAt, null);

    const missingKey = await app.inject({
      method: "POST",
      url: "/api/v1/agent/hooks/lifecycle",
      headers: { authorization: `Bearer ${credential.token}` },
      payload: {
        event: "run.failed",
        session_id: sessionId,
        runtime: "codex",
        integration: "codex"
      }
    });
    assert.equal(missingKey.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("lifecycle credential cannot write another agent's session", async () => {
  const { app } = await fixture();
  try {
    const organization = (
      await app.inject({
        method: "POST",
        url: "/api/v1/organizations",
        headers: human,
        payload: { name: "Scope org" }
      })
    ).json();
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organization.id}/projects`,
        headers: human,
        payload: { name: "Scope project" }
      })
    ).json();
    const create = async (name: string) =>
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.id}/agents`,
          headers: human,
          payload: { name }
        })
      ).json();
    const agentA = await create("a");
    const agentB = await create("b");
    const credentialA = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents/${agentA.id}/credentials`,
        headers: human
      })
    ).json();
    const credentialB = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents/${agentB.id}/credentials`,
        headers: human
      })
    ).json();
    const sessionId = randomUUID();
    const startedByB = await app.inject({
      method: "POST",
      url: "/api/v1/agent/hooks/lifecycle",
      headers: {
        authorization: `Bearer ${credentialB.token}`,
        "idempotency-key": "scope-start"
      },
      payload: {
        event: "session.started",
        session_id: sessionId,
        runtime: "codex",
        integration: "codex"
      }
    });
    assert.equal(startedByB.statusCode, 200);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/hooks/lifecycle",
      headers: {
        authorization: `Bearer ${credentialA.token}`,
        "idempotency-key": "scope-check"
      },
      payload: {
        event: "session.ended",
        session_id: sessionId,
        runtime: "codex",
        integration: "codex"
      }
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await app.close();
  }
});
