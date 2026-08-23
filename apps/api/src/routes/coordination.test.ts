import assert from "node:assert/strict";
import test from "node:test";
import {
  agentSessions,
  projectEvents,
  taskClaims,
  tasks
} from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
import { fixture } from "../test/fixture.js";

const human = (name: string) => ({ authorization: `Bearer ${name}` });

test("two agent HTTP claims have one winner and one durable claim event", async () => {
  const { app, db } = await fixture();
  try {
    const organization = (
      await app.inject({
        method: "POST",
        url: "/api/v1/organizations",
        headers: human("alice"),
        payload: { name: "Coordination" }
      })
    ).json();
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organization.id}/projects`,
        headers: human("alice"),
        payload: { name: "Claims" }
      })
    ).json();
    const otherProject = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organization.id}/projects`,
        headers: human("alice"),
        payload: { name: "Other project" }
      })
    ).json();
    const task = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/tasks`,
        headers: { ...human("alice"), "idempotency-key": "claim-task" },
        payload: { title: "Race", status: "ready" }
      })
    ).json();
    const createAgent = (name: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents`,
        headers: human("alice"),
        payload: { name }
      });
    const agentA = (await createAgent("agent-a")).json();
    const agentB = (await createAgent("agent-b")).json();
    const agentC = (await createAgent("agent-c")).json();
    const credentialA = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents/${agentA.id}/credentials`,
        headers: human("alice")
      })
    ).json();
    const credentialB = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents/${agentB.id}/credentials`,
        headers: human("alice")
      })
    ).json();
    const credentialC = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents/${agentC.id}/credentials`,
        headers: human("alice")
      })
    ).json();
    const sessionA = (
      await app.inject({
        method: "POST",
        url: "/api/v1/agent/sessions",
        headers: { authorization: `Bearer ${credentialA.token}` },
        payload: { runtime: "test", integration: "a" }
      })
    ).json().session;
    const sessionB = (
      await app.inject({
        method: "POST",
        url: "/api/v1/agent/sessions",
        headers: { authorization: `Bearer ${credentialB.token}` },
        payload: { runtime: "test", integration: "b" }
      })
    ).json().session;
    const sessionC = (
      await app.inject({
        method: "POST",
        url: "/api/v1/agent/sessions",
        headers: { authorization: `Bearer ${credentialC.token}` },
        payload: { runtime: "test", integration: "c" }
      })
    ).json().session;
    const listTasks = (token: string) =>
      app.inject({
        method: "GET",
        url: "/api/v1/agent/tasks?status=ready",
        headers: { authorization: `Bearer ${token}` }
      });
    for (const token of [credentialA.token, credentialB.token]) {
      const listed = await listTasks(token);
      assert.equal(listed.statusCode, 200);
      assert.equal(
        listed.json().tasks.some((item: any) => item.id === task.id),
        true
      );
    }
    const wrongProject = await app.inject({
      method: "GET",
      url: `/api/v1/agent/tasks/${task.id}`,
      headers: { authorization: `Bearer ${credentialA.token}` }
    });
    assert.equal(wrongProject.statusCode, 200);
    assert.equal(wrongProject.json().project_id, project.id);
    const otherTask = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${otherProject.id}/tasks`,
        headers: { ...human("alice"), "idempotency-key": "other-task" },
        payload: { title: "Other task", status: "ready" }
      })
    ).json();
    const wrongProjectTask = await app.inject({
      method: "GET",
      url: `/api/v1/agent/tasks/${otherTask.id}`,
      headers: { authorization: `Bearer ${credentialA.token}` }
    });
    assert.equal(wrongProjectTask.statusCode, 404);
    const request = (token: string, sessionId: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/agent/tasks/${task.id}/claim`,
        headers: { authorization: `Bearer ${token}` },
        payload: { session_id: sessionId, lease_seconds: 300 }
      });
    const attempts = [
      { credential: credentialA, session: sessionA },
      { credential: credentialB, session: sessionB }
    ];
    const responses = await Promise.all(
      attempts.map(({ credential, session }) =>
        request(credential.token, session.id)
      )
    );
    assert.equal(
      responses.filter((response) => response.statusCode === 200).length,
      1
    );
    const conflict = responses.find((response) => response.statusCode === 409);
    assert.equal(conflict?.json().error.code, "TASK_ALREADY_CLAIMED");
    assert.equal(conflict?.json().error.details.task_id, task.id);
    const active = await db
      .select()
      .from(taskClaims)
      .where(
        and(eq(taskClaims.taskId, task.id), eq(taskClaims.status, "active"))
      );
    assert.equal(active.length, 1);
    assert.equal(
      (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]?.status,
      "claimed"
    );
    const events = await db
      .select()
      .from(projectEvents)
      .where(
        and(
          eq(projectEvents.projectId, project.id),
          eq(projectEvents.type, "claim.created")
        )
      );
    assert.equal(events.length, 1);

    const winnerIndex = responses.findIndex(
      (response) => response.statusCode === 200
    );
    const winnerAttempt = attempts[winnerIndex]!;
    const winner = responses[winnerIndex]!.json();
    const winnerToken = winner.claim_token;
    const winnerSession = winner.claim.session_id;
    const winnerCredential = winnerAttempt.credential;
    const winnerSecondSession = (
      await app.inject({
        method: "POST",
        url: "/api/v1/agent/sessions",
        headers: { authorization: `Bearer ${winnerCredential.token}` },
        payload: { runtime: "test", integration: "same-agent-second-session" }
      })
    ).json().session;
    const wrongOwner = await app.inject({
      method: "POST",
      url: `/api/v1/agent/sessions/${winnerSecondSession.id}/claims/release`,
      headers: { authorization: `Bearer ${winnerCredential.token}` },
      payload: { claim_token: winnerToken }
    });
    assert.equal(wrongOwner.statusCode, 403);
    assert.equal(wrongOwner.json().error.code, "CLAIM_NOT_OWNER");

    const leaseBefore = (
      await db
        .select()
        .from(taskClaims)
        .where(eq(taskClaims.id, winner.claim.id))
    )[0]!.leaseExpiresAt;
    const heartbeat = await app.inject({
      method: "POST",
      url: `/api/v1/agent/sessions/${winnerSession}/heartbeat`,
      headers: { authorization: `Bearer ${winnerCredential.token}` }
    });
    assert.equal(heartbeat.statusCode, 200);
    const leaseAfter = (
      await db
        .select()
        .from(taskClaims)
        .where(eq(taskClaims.id, winner.claim.id))
    )[0]!.leaseExpiresAt;
    assert.equal(leaseAfter.getTime() > leaseBefore.getTime(), true);

    await db
      .update(agentSessions)
      .set({ lastHeartbeatAt: new Date(Date.now() - 120_000) })
      .where(eq(agentSessions.id, sessionC.id));
    const stale = await app.inject({
      method: "POST",
      url: `/api/v1/agent/sessions/${sessionC.id}/heartbeat`,
      headers: { authorization: `Bearer ${credentialC.token}` }
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "AGENT_SESSION_STALE");

    const release = await app.inject({
      method: "POST",
      url: `/api/v1/agent/sessions/${winnerSession}/claims/release`,
      headers: { authorization: `Bearer ${winnerCredential.token}` },
      payload: { claim_token: winnerToken }
    });
    assert.equal(release.statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/agent/tasks/${task.id}`,
          headers: { authorization: `Bearer ${credentialA.token}` }
        })
      ).json().status,
      "ready"
    );

    const reopened = (
      await app.inject({
        method: "POST",
        url: "/api/v1/agent/sessions",
        headers: { authorization: `Bearer ${credentialB.token}` },
        payload: { runtime: "test", integration: "b-reopened" }
      })
    ).json().session;
    const reclaimed = await app.inject({
      method: "POST",
      url: `/api/v1/agent/tasks/${task.id}/claim`,
      headers: { authorization: `Bearer ${credentialB.token}` },
      payload: { session_id: reopened.id, lease_seconds: 30 }
    });
    assert.equal(reclaimed.statusCode, 200);
    await db
      .update(taskClaims)
      .set({ leaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(taskClaims.id, reclaimed.json().claim.id));
    const reconciled = await listTasks(credentialA.token);
    assert.equal(reconciled.statusCode, 200);
    assert.equal(
      reconciled.json().tasks.find((item: any) => item.id === task.id).status,
      "ready"
    );

    const finalClaim = (
      await app.inject({
        method: "POST",
        url: `/api/v1/agent/tasks/${task.id}/claim`,
        headers: { authorization: `Bearer ${credentialA.token}` },
        payload: { session_id: sessionA.id, lease_seconds: 30 }
      })
    ).json();
    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/agent/sessions/${sessionA.id}/claims/complete`,
      headers: { authorization: `Bearer ${credentialA.token}` },
      payload: { claim_token: finalClaim.claim_token }
    });
    assert.equal(complete.statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/agent/tasks/${task.id}`,
          headers: { authorization: `Bearer ${credentialA.token}` }
        })
      ).json().status,
      "done"
    );

    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/agents/${agentB.id}/revoke`,
      headers: human("alice")
    });
    assert.equal(revoked.statusCode, 200);
    const revokedAccess = await app.inject({
      method: "GET",
      url: "/api/v1/agent/events",
      headers: { authorization: `Bearer ${credentialB.token}` }
    });
    assert.equal(revokedAccess.statusCode, 401);
    assert.equal(revokedAccess.json().error.code, "AGENT_CREDENTIAL_REVOKED");
  } finally {
    await app.close();
  }
});
