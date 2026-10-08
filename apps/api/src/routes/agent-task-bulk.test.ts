import assert from "node:assert/strict";
import test from "node:test";
import { projectEvents, tasks } from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
import { fixture } from "../test/fixture.js";

let keys = 0;
const nextKey = () => `bulk-${++keys}`;
const human = { authorization: "Bearer alice" };

async function setup() {
  const { app, db } = await fixture();
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: human,
      payload: { name: "Bulk" }
    })
  ).json();
  const project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organization.id}/projects`,
      headers: human,
      payload: { name: "Bulk tasks", task_key_prefix: "BK" }
    })
  ).json();
  const createAgent = async (name: string) => {
    const agent = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents`,
        headers: human,
        payload: { name }
      })
    ).json();
    const token = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents/${agent.id}/credentials`,
        headers: human
      })
    ).json().token as string;
    const session = (
      await app.inject({
        method: "POST",
        url: "/api/v1/agent/sessions",
        headers: { authorization: `Bearer ${token}` },
        payload: { runtime: "test", integration: name }
      })
    ).json().session;
    return { id: agent.id as string, token, sessionId: session.id as string };
  };
  const agentA = await createAgent("agent-a");
  const agentB = await createAgent("agent-b");
  const asAgent = (
    agent: { token: string },
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: unknown,
    key = nextKey()
  ) =>
    app.inject({
      method,
      url: `/api/v1/agent${url}`,
      headers: {
        authorization: `Bearer ${agent.token}`,
        "idempotency-key": key
      },
      ...(payload === undefined ? {} : { payload: payload as object })
    });
  const createTask = async (title: string, status = "backlog") => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tasks`,
      headers: { ...human, "idempotency-key": nextKey() },
      payload: { title, status }
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as { id: string; key: string; version: number };
  };
  const taskRow = async (id: string) =>
    (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const events = (taskId: string) =>
    db
      .select()
      .from(projectEvents)
      .where(
        and(
          eq(projectEvents.projectId, project.id),
          eq(projectEvents.entityId, taskId)
        )
      );
  return {
    app,
    db,
    project,
    agentA,
    agentB,
    asAgent,
    createTask,
    taskRow,
    events
  };
}

test("agents move unclaimed tasks with update_task as one version bump", async () => {
  const { app, agentA, asAgent, createTask, events } = await setup();
  try {
    const task = await createTask("Plan");
    const moved = await asAgent(agentA, "PATCH", `/tasks/${task.id}`, {
      status: "ready",
      title: "Plan it",
      expected_version: 1
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(moved.json().status, "ready");
    assert.equal(moved.json().title, "Plan it");
    assert.equal(moved.json().version, 2);
    const recorded = await events(task.id);
    const movedEvent = recorded.find((event) => event.type === "task.moved")!;
    assert.equal(movedEvent.actorAgentId, agentA.id);
    assert.equal(movedEvent.actorUserId, null);
    assert.deepEqual(movedEvent.payload, {
      from_status: "backlog",
      to_status: "ready"
    });
    const updatedEvent = recorded.find(
      (event) => event.type === "task.updated"
    )!;
    assert.equal(updatedEvent.actorAgentId, agentA.id);
    assert.deepEqual(updatedEvent.payload, {
      fields: ["title", "expected_version"]
    });

    // The current column is not a move and does not bump the version.
    const same = await asAgent(agentA, "PATCH", `/tasks/${task.id}`, {
      status: "ready",
      expected_version: 2
    });
    assert.equal(same.statusCode, 200, same.body);
    assert.equal(same.json().version, 2);

    const stale = await asAgent(agentA, "PATCH", `/tasks/${task.id}`, {
      status: "in_progress",
      expected_version: 1
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "TASK_VERSION_CONFLICT");
    assert.equal(stale.json().error.details.current_version, 2);

    const claimed = await asAgent(agentA, "PATCH", `/tasks/${task.id}`, {
      status: "claimed",
      expected_version: 2
    });
    assert.equal(claimed.statusCode, 400);
    const empty = await asAgent(agentA, "PATCH", `/tasks/${task.id}`, {
      expected_version: 2
    });
    assert.equal(empty.statusCode, 400);

    const cancelled = await asAgent(agentA, "PATCH", `/tasks/${task.id}`, {
      status: "cancelled",
      expected_version: 2
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.ok(cancelled.json().cancelled_at);
  } finally {
    await app.close();
  }
});

test("update_task status refuses claimed tasks and keeps the claim tools for the owner", async () => {
  const { app, agentA, agentB, asAgent, createTask, taskRow } = await setup();
  try {
    const task = await createTask("Claimed", "ready");
    const claim = await asAgent(agentB, "POST", `/tasks/${task.id}/claim`, {
      session_id: agentB.sessionId
    });
    assert.equal(claim.statusCode, 200, claim.body);
    const version = (await taskRow(task.id)).version;

    const other = await asAgent(agentA, "PATCH", `/tasks/${task.id}`, {
      status: "backlog",
      expected_version: version
    });
    assert.equal(other.statusCode, 409);
    assert.equal(other.json().error.code, "TASK_NOT_CLAIMABLE");
    assert.equal(other.json().error.details.reason, "claimed");
    assert.equal(other.json().error.details.agent_id, agentB.id);

    const own = await asAgent(agentB, "PATCH", `/tasks/${task.id}`, {
      status: "done",
      expected_version: version
    });
    assert.equal(own.statusCode, 409);
    assert.equal(own.json().error.code, "TASK_NOT_CLAIMABLE");
    assert.equal(own.json().error.details.reason, "own_claim");
    assert.match(own.json().error.message, /set_task_status/);
    assert.equal((await taskRow(task.id)).status, "claimed");

    // Field edits on a claimed task keep working as before.
    const renamed = await asAgent(agentA, "PATCH", `/tasks/${task.id}`, {
      title: "Claimed, renamed",
      expected_version: version
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
  } finally {
    await app.close();
  }
});

test("moving to review or done needs acknowledged comments from others", async () => {
  const { app, agentA, asAgent, createTask, taskRow } = await setup();
  try {
    const task = await createTask("Reviewed", "ready");
    const own = await asAgent(agentA, "POST", `/tasks/${task.id}/comments`, {
      body_markdown: "Starting"
    });
    assert.equal(own.statusCode, 201, own.body);
    // The agent's own comment never blocks it.
    const review = await asAgent(agentA, "PATCH", `/tasks/${task.id}`, {
      status: "review",
      expected_version: 1
    });
    assert.equal(review.statusCode, 200, review.body);

    const comment = await app.inject({
      method: "POST",
      url: `/api/v1/tasks/${task.id}/comments`,
      headers: { ...human, "idempotency-key": nextKey() },
      payload: { body_markdown: "Hold on, the schema changed" }
    });
    assert.equal(comment.statusCode, 201, comment.body);
    const refused = await asAgent(agentA, "PATCH", `/tasks/${task.id}`, {
      status: "done",
      expected_version: 2
    });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error.code, "TASK_COMMENTS_UNREAD");
    const latest = refused.json().error.details.latest_sequence as number;
    assert.equal(refused.json().error.details.total_unread, 1);
    assert.equal((await taskRow(task.id)).status, "review");

    const done = await asAgent(agentA, "PATCH", `/tasks/${task.id}`, {
      status: "done",
      acknowledged_through: latest,
      expected_version: 2
    });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.json().status, "done");
    assert.ok(done.json().completed_at);

    // Leaving done is not guarded.
    const reopened = await asAgent(agentA, "PATCH", `/tasks/${task.id}`, {
      status: "ready",
      expected_version: 3
    });
    assert.equal(reopened.statusCode, 200, reopened.body);
  } finally {
    await app.close();
  }
});

test("bulk create allocates keys in order, replays by key, and applies nothing on failure", async () => {
  const { app, db, project, agentA, asAgent, events } = await setup();
  try {
    const body = {
      tasks: [
        { title: "First" },
        { title: "Second", status: "ready", priority: "high" },
        { title: "Third", description: "Notes" }
      ]
    };
    const created = await asAgent(agentA, "POST", "/tasks/bulk", body, "batch");
    assert.equal(created.statusCode, 201, created.body);
    const result = created.json().tasks as {
      id: string;
      key: string;
      title: string;
      status: string;
      created_by: unknown;
    }[];
    assert.deepEqual(
      result.map((task) => [task.key, task.title, task.status]),
      [
        ["BK-1", "First", "backlog"],
        ["BK-2", "Second", "ready"],
        ["BK-3", "Third", "backlog"]
      ]
    );
    assert.deepEqual(result[0]!.created_by, { type: "agent", id: agentA.id });
    for (const task of result) {
      const recorded = await events(task.id);
      assert.deepEqual(
        recorded.map((event) => [event.type, event.actorAgentId]),
        [["task.created", agentA.id]]
      );
    }

    const replay = await asAgent(agentA, "POST", "/tasks/bulk", body, "batch");
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(
      replay.json().tasks.map((task: { id: string }) => task.id),
      result.map((task) => task.id)
    );
    const conflict = await asAgent(
      agentA,
      "POST",
      "/tasks/bulk",
      { tasks: [{ title: "Different" }] },
      "batch"
    );
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");
    const missingKey = await app.inject({
      method: "POST",
      url: "/api/v1/agent/tasks/bulk",
      headers: { authorization: `Bearer ${agentA.token}` },
      payload: { tasks: [{ title: "No key" }] }
    });
    assert.equal(missingKey.statusCode, 400);

    const invalid = await asAgent(agentA, "POST", "/tasks/bulk", {
      tasks: [{ title: "Fine" }, { title: "Done already", status: "done" }]
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "VALIDATION_ERROR");
    assert.equal(invalid.json().error.details.index, 1);
    assert.equal(invalid.json().error.details.title, "Done already");
    const tooMany = await asAgent(agentA, "POST", "/tasks/bulk", {
      tasks: Array.from({ length: 51 }, (_, n) => ({ title: `T${n}` }))
    });
    assert.equal(tooMany.statusCode, 400);
    const empty = await asAgent(agentA, "POST", "/tasks/bulk", { tasks: [] });
    assert.equal(empty.statusCode, 400);
    const all = await db
      .select()
      .from(tasks)
      .where(eq(tasks.projectId, project.id));
    assert.equal(all.length, 3);

    // The next batch continues the key sequence: failures consumed nothing.
    const next = await asAgent(agentA, "POST", "/tasks/bulk", {
      tasks: [{ title: "Fourth" }]
    });
    assert.equal(next.json().tasks[0].key, "BK-4");
  } finally {
    await app.close();
  }
});

test("bulk update is atomic, ordered, and names the failing item", async () => {
  const { app, agentA, agentB, asAgent, createTask, taskRow, events } =
    await setup();
  try {
    const first = await createTask("First");
    const second = await createTask("Second");
    const bumped = await asAgent(agentA, "PATCH", `/tasks/${second.id}`, {
      priority: "low",
      expected_version: 1
    });
    assert.equal(bumped.json().version, 2);

    const stale = await asAgent(agentA, "PATCH", "/tasks/bulk", {
      tasks: [
        {
          task_id: first.id,
          priority: "high",
          status: "ready",
          expected_version: 1
        },
        { task_id: second.id, status: "ready", expected_version: 1 }
      ]
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "TASK_VERSION_CONFLICT");
    assert.deepEqual(stale.json().error.details, {
      current_version: 2,
      index: 1,
      task_id: second.id
    });
    const untouched = await taskRow(first.id);
    assert.equal(untouched.priority, "none");
    assert.equal(untouched.status, "backlog");
    assert.equal(untouched.version, 1);
    assert.equal(
      (await events(first.id)).filter((event) => event.type === "task.moved")
        .length,
      0
    );

    const duplicate = await asAgent(agentA, "PATCH", "/tasks/bulk", {
      tasks: [
        { task_id: first.id, priority: "high", expected_version: 1 },
        { task_id: first.id, status: "ready", expected_version: 1 }
      ]
    });
    assert.equal(duplicate.statusCode, 400);
    assert.equal(duplicate.json().error.code, "VALIDATION_ERROR");
    assert.equal(duplicate.json().error.details.index, 1);
    assert.equal(duplicate.json().error.details.task_id, first.id);

    const updated = await asAgent(agentA, "PATCH", "/tasks/bulk", {
      tasks: [
        { task_id: second.id, status: "ready", expected_version: 2 },
        { task_id: first.id, title: "First, renamed", expected_version: 1 }
      ]
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(
      updated
        .json()
        .tasks.map((task: { id: string; status: string; version: number }) => [
          task.id,
          task.status,
          task.version
        ]),
      [
        [second.id, "ready", 3],
        [first.id, "backlog", 2]
      ]
    );

    const claim = await asAgent(agentB, "POST", `/tasks/${second.id}/claim`, {
      session_id: agentB.sessionId
    });
    assert.equal(claim.statusCode, 200, claim.body);
    const claimedVersion = (await taskRow(second.id)).version;
    const refused = await asAgent(agentA, "PATCH", "/tasks/bulk", {
      tasks: [
        { task_id: first.id, status: "ready", expected_version: 2 },
        {
          task_id: second.id,
          status: "backlog",
          expected_version: claimedVersion
        }
      ]
    });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.json().error.code, "TASK_NOT_CLAIMABLE");
    assert.equal(refused.json().error.details.index, 1);
    assert.equal((await taskRow(first.id)).status, "backlog");
  } finally {
    await app.close();
  }
});
