import assert from "node:assert/strict";
import test from "node:test";
import { agents, taskComments, tasks } from "@orchestrat/db";
import { eq } from "drizzle-orm";
import { fixture } from "../test/fixture.js";

const human = (name: string) => ({ authorization: `Bearer ${name}` });

test("agents author tasks and mixed comments with scoped idempotency", async () => {
  const { app, db } = await fixture();
  try {
    const organization = (
      await app.inject({
        method: "POST",
        url: "/api/v1/organizations",
        headers: human("alice"),
        payload: { name: "Agent authoring" }
      })
    ).json();
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organization.id}/projects`,
        headers: human("alice"),
        payload: { name: "Tasks", task_key_prefix: "AT" }
      })
    ).json();
    const agent = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents`,
        headers: human("alice"),
        payload: { name: "Builder" }
      })
    ).json();
    const credential = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents/${agent.id}/credentials`,
        headers: human("alice")
      })
    ).json();
    const auth = { authorization: `Bearer ${credential.token}` };

    const selectedProject = await app.inject({
      method: "GET",
      url: "/api/v1/agent/project",
      headers: auth
    });
    assert.equal(selectedProject.statusCode, 200);
    assert.equal(selectedProject.json().id, project.id);

    const createdResponse = await app.inject({
      method: "POST",
      url: "/api/v1/agent/tasks",
      headers: { ...auth, "idempotency-key": "follow-up-1" },
      payload: { title: "Follow up", priority: "high" }
    });
    assert.equal(createdResponse.statusCode, 201);
    const created = createdResponse.json();
    assert.deepEqual(created.created_by, { type: "agent", id: agent.id });
    assert.equal(created.created_by_user_id, null);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/agent/tasks",
          headers: { ...auth, "idempotency-key": "follow-up-1" },
          payload: { title: "Follow up", priority: "high" }
        })
      ).json().id,
      created.id
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/agent/tasks",
          headers: { ...auth, "idempotency-key": "follow-up-1" },
          payload: { title: "Different" }
        })
      ).json().error.code,
      "IDEMPOTENCY_CONFLICT"
    );

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/agent/tasks/${created.id}`,
      headers: auth,
      payload: { priority: "urgent", expected_version: 1 }
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().version, 2);
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/agent/tasks/${created.id}`,
      headers: auth,
      payload: { title: "Lost update", expected_version: 1 }
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.details.current_version, 2);

    await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${created.id}/comments`,
      headers: { ...human("alice"), "idempotency-key": "human-note" },
      payload: { body_markdown: "Human note" }
    });
    const agentComment = await app.inject({
      method: "POST",
      url: `/api/v1/agent/tasks/${created.id}/comments`,
      headers: { ...auth, "idempotency-key": "agent-note" },
      payload: { body_markdown: "Agent note" }
    });
    assert.equal(agentComment.statusCode, 201);
    assert.equal(agentComment.json().author.type, "agent");
    assert.equal(agentComment.json().author.full_name, "Builder");
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/agent/tasks/${created.id}/comments`,
      headers: { ...auth, "idempotency-key": "agent-note" },
      payload: { body_markdown: "Agent note" }
    });
    assert.equal(replay.json().id, agentComment.json().id);

    await db
      .update(agents)
      .set({ name: "Renamed" })
      .where(eq(agents.id, agent.id));
    const comments = (
      await app.inject({
        method: "GET",
        url: `/api/v1/tasks/${created.id}/comments`,
        headers: human("alice")
      })
    ).json().comments;
    assert.deepEqual(
      comments.map(
        (comment: { author: { type: string; full_name: string } }) => [
          comment.author.type,
          comment.author.full_name
        ]
      ),
      [
        ["human", "alice"],
        ["agent", "Builder"]
      ]
    );
    assert.equal(
      (await db.select().from(tasks).where(eq(tasks.id, created.id))).length,
      1
    );
    assert.equal(
      (
        await db
          .select()
          .from(taskComments)
          .where(eq(taskComments.taskId, created.id))
      ).length,
      2
    );
  } finally {
    await app.close();
  }
});
