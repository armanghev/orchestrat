import assert from "node:assert/strict";
import test from "node:test";
import {
  organizationMembers,
  projectEvents,
  taskBlocks,
  taskClaims,
  tasks,
  users
} from "@orchestrat/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { fixture } from "../test/fixture.js";

type Setup = Awaited<ReturnType<typeof setup>>;
type Agent = { id: string; token: string; sessionId: string };
let keys = 0;
const nextKey = () => `status-${++keys}`;
const human = (name: "alice" | "bob") => ({ authorization: `Bearer ${name}` });

async function setup() {
  const { app, db } = await fixture();
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: human("alice"),
      payload: { name: "Status" }
    })
  ).json();
  const createProject = async (name: string) =>
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organization.id}/projects`,
        headers: human("alice"),
        payload: { name }
      })
    ).json();
  const project = await createProject("Status project");
  const otherProject = await createProject("Other status project");
  await app.inject({
    method: "GET",
    url: "/api/v1/profile",
    headers: human("bob")
  });
  const [bob] = await db
    .select()
    .from(users)
    .where(eq(users.email, "bob@example.com"));
  await db.insert(organizationMembers).values({
    organizationId: organization.id,
    userId: bob.id,
    role: "member"
  });
  const added = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/members`,
    headers: human("alice"),
    payload: { user_id: bob.id }
  });
  assert.equal(added.statusCode, 201, added.body);

  const createAgent = async (name: string, projectId = project.id) => {
    const agent = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/agents`,
        headers: human("alice"),
        payload: { name }
      })
    ).json();
    const token = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/agents/${agent.id}/credentials`,
        headers: human("alice")
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
    method: "GET" | "POST",
    url: string,
    payload?: unknown
  ) =>
    app.inject({
      method,
      url: `/api/v1/agent${url}`,
      headers: {
        authorization: `Bearer ${agent.token}`,
        "idempotency-key": nextKey()
      },
      ...(payload === undefined ? {} : { payload: payload as object })
    });
  const asHuman = (
    name: "alice" | "bob",
    method: "GET" | "POST",
    url: string,
    payload?: unknown
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { ...human(name), "idempotency-key": nextKey() },
      ...(payload === undefined ? {} : { payload: payload as object })
    });
  const createTask = async (title: string, projectId = project.id) => {
    const response = await asHuman(
      "alice",
      "POST",
      `/projects/${projectId}/tasks`,
      {
        title,
        status: "ready"
      }
    );
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as { id: string; key: string };
  };
  const claim = async (agent: Agent, taskId: string) => {
    const response = await asAgent(agent, "POST", `/tasks/${taskId}/claim`, {
      session_id: agent.sessionId,
      lease_seconds: 300
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().claim_token as string;
  };
  const setStatus = (agent: Agent, claimToken: string, body: object) =>
    asAgent(agent, "POST", `/sessions/${agent.sessionId}/claims/status`, {
      claim_token: claimToken,
      ...body
    });
  const block = async (agent: Agent, claimToken: string, body: object = {}) => {
    const response = await setStatus(agent, claimToken, {
      status: "blocked",
      reason: "waiting",
      ...body
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const endClaim = (
    agent: Agent,
    action: "complete" | "release",
    claimToken: string
  ) =>
    asAgent(agent, "POST", `/sessions/${agent.sessionId}/claims/${action}`, {
      claim_token: claimToken
    });
  const move = async (taskId: string, status: string) => {
    const current = await asHuman("alice", "GET", `/tasks/${taskId}`);
    assert.equal(current.statusCode, 200, current.body);
    return asHuman("alice", "POST", `/tasks/${taskId}/move`, {
      status,
      expected_version: current.json().version
    });
  };
  const taskRow = async (taskId: string) =>
    (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
  const blocksOf = (taskId: string) =>
    db
      .select()
      .from(taskBlocks)
      .where(eq(taskBlocks.taskId, taskId))
      .orderBy(asc(taskBlocks.createdAt));
  const eventsFor = (entityId: string, types: string[]) =>
    db
      .select()
      .from(projectEvents)
      .where(
        and(
          eq(projectEvents.entityId, entityId),
          inArray(projectEvents.type, types)
        )
      )
      .orderBy(asc(projectEvents.id));
  const summary = async (agent: Agent) => {
    const response = await asAgent(agent, "GET", "/attention");
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  return {
    app,
    db,
    project,
    otherProject,
    bob,
    agentA,
    agentB,
    createAgent,
    asAgent,
    asHuman,
    createTask,
    claim,
    setStatus,
    block,
    endClaim,
    move,
    taskRow,
    blocksOf,
    eventsFor,
    summary
  };
}

const withSetup = (name: string, body: (s: Setup) => Promise<void>) =>
  test(name, async (t) => {
    const s = await setup();
    t.after(() => s.app.close());
    await body(s);
  });

withSetup(
  "in_progress sets started_at once and repeats as a no-op",
  async (s) => {
    const task = await s.createTask("Start");
    const token = await s.claim(s.agentA, task.id);
    const started = await s.setStatus(s.agentA, token, {
      status: "in_progress"
    });
    assert.equal(started.statusCode, 200, started.body);
    const body = started.json();
    assert.equal(body.task.status, "in_progress");
    assert.equal(body.task.key, task.key);
    assert.equal(body.claim.status, "active");
    assert.equal(body.block, null);
    const row = await s.taskRow(task.id);
    assert.ok(row.startedAt);
    assert.equal(row.version, body.task.version);
    const [event] = await s.eventsFor(task.id, ["task.status_changed"]);
    assert.equal(event.actorAgentId, s.agentA.id);
    assert.deepEqual(event.payload, {
      from_status: "claimed",
      to_status: "in_progress",
      claim_id: body.claim.id
    });

    const again = await s.setStatus(s.agentA, token, { status: "in_progress" });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().task.version, body.task.version);
    assert.equal(
      (await s.eventsFor(task.id, ["task.status_changed"])).length,
      1
    );
    assert.deepEqual((await s.taskRow(task.id)).startedAt, row.startedAt);
  }
);

withSetup(
  "blocked opens a block, replaces it, and in_progress resolves it",
  async (s) => {
    const blocker = await s.createTask("Blocker");
    const task = await s.createTask("Blocked");
    const token = await s.claim(s.agentA, task.id);
    const first = await s.block(s.agentA, token, {
      reason: "needs the API",
      blocked_on: { type: "agent", id: s.agentB.id }
    });
    assert.equal(first.task.status, "blocked");
    assert.equal(first.claim.status, "active");
    assert.equal(first.block.reason, "needs the API");
    assert.deepEqual(first.block.blocked_on, {
      type: "agent",
      id: s.agentB.id,
      name: "agent-b"
    });
    assert.deepEqual(first.block.created_by, {
      type: "agent",
      id: s.agentA.id,
      name: "agent-a"
    });
    assert.equal(first.block.blocking_task, null);
    assert.equal(first.block.resolution, null);
    const [opened] = await s.eventsFor(task.id, ["task.status_changed"]);
    assert.deepEqual(opened.payload, {
      from_status: "claimed",
      to_status: "blocked",
      claim_id: first.claim.id,
      block: {
        id: first.block.id,
        blocked_on: { type: "agent", id: s.agentB.id },
        blocking_task_id: null
      }
    });

    const second = await s.block(s.agentA, token, {
      reason: "now waiting on the blocker task",
      blocking_task_id: blocker.id,
      blocked_on: { type: "human", id: s.bob.id }
    });
    assert.equal(second.task.status, "blocked");
    assert.deepEqual(second.block.blocking_task, {
      id: blocker.id,
      key: blocker.key,
      title: "Blocker"
    });
    assert.deepEqual(second.block.blocked_on, {
      type: "human",
      id: s.bob.id,
      name: "bob"
    });
    let blocks = await s.blocksOf(task.id);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].id, first.block.id);
    assert.equal(blocks[0].resolution, "status_changed");
    assert.equal(blocks[0].resolvedByAgentId, s.agentA.id);
    assert.ok(blocks[0].resolutionSeenAt, "the creator resolved it itself");
    assert.equal(blocks[1].resolvedAt, null);

    const resumed = await s.setStatus(s.agentA, token, {
      status: "in_progress"
    });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(resumed.json().task.status, "in_progress");
    assert.equal(resumed.json().block, null);
    blocks = await s.blocksOf(task.id);
    assert.equal(blocks[1].resolution, "status_changed");
    assert.ok((await s.taskRow(task.id)).startedAt);
    const resolved = await s.eventsFor(task.id, ["task.block_resolved"]);
    assert.deepEqual(
      resolved.map((event) => event.payload),
      [
        {
          block_id: first.block.id,
          resolution: "status_changed",
          to_status: "blocked"
        },
        {
          block_id: second.block.id,
          resolution: "status_changed",
          to_status: "in_progress"
        }
      ]
    );
    const changes = await s.eventsFor(task.id, ["task.status_changed"]);
    assert.deepEqual(
      changes.map((event) => [
        event.payload.from_status,
        event.payload.to_status
      ]),
      [
        ["claimed", "blocked"],
        ["blocked", "blocked"],
        ["blocked", "in_progress"]
      ]
    );
  }
);

withSetup(
  "review runs the guard, ends the claim and resolves a block",
  async (s) => {
    const task = await s.createTask("Review me");
    const token = await s.claim(s.agentA, task.id);
    await s.block(s.agentA, token);
    const comment = await s.asAgent(
      s.agentB,
      "POST",
      `/tasks/${task.id}/comments`,
      {
        body_markdown: "please double check"
      }
    );
    assert.equal(comment.statusCode, 201, comment.body);
    const refused = await s.setStatus(s.agentA, token, { status: "review" });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(refused.json().error.code, "TASK_COMMENTS_UNREAD");
    assert.equal(refused.json().error.details.total_unread, 1);
    assert.equal((await s.taskRow(task.id)).status, "blocked");

    const reviewed = await s.setStatus(s.agentA, token, {
      status: "review",
      acknowledged_through: 1
    });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    const body = reviewed.json();
    assert.equal(body.task.status, "review");
    assert.equal(body.claim.status, "released");
    const [claimRow] = await s.db
      .select()
      .from(taskClaims)
      .where(eq(taskClaims.id, body.claim.id));
    assert.equal(claimRow.releaseReason, "submitted_for_review");
    const [blockRow] = await s.blocksOf(task.id);
    assert.equal(blockRow.resolution, "status_changed");
    const [released] = await s.eventsFor(body.claim.id, ["claim.released"]);
    assert.deepEqual(released.payload, {
      task_id: task.id,
      session_id: s.agentA.sessionId,
      reason: "submitted_for_review"
    });
    const [change] = (
      await s.eventsFor(task.id, ["task.status_changed"])
    ).slice(-1);
    assert.deepEqual(change.payload, {
      from_status: "blocked",
      to_status: "review",
      claim_id: body.claim.id
    });

    // The claim is over: the token no longer works and review is not claimable.
    const reused = await s.setStatus(s.agentA, token, {
      status: "in_progress"
    });
    assert.equal(reused.statusCode, 409, reused.body);
    assert.equal(reused.json().error.code, "CLAIM_NOT_FOUND");
    const reclaim = await s.asAgent(
      s.agentB,
      "POST",
      `/tasks/${task.id}/claim`,
      {
        session_id: s.agentB.sessionId,
        lease_seconds: 300
      }
    );
    assert.equal(reclaim.statusCode, 409, reclaim.body);
    assert.equal(reclaim.json().error.code, "TASK_NOT_CLAIMABLE");
    // A human can move a review task once the claim has ended.
    assert.equal((await s.move(task.id, "done")).statusCode, 200);
  }
);

withSetup("claimed can go straight to review or blocked", async (s) => {
  const reviewTask = await s.createTask("Straight to review");
  const reviewToken = await s.claim(s.agentA, reviewTask.id);
  const reviewed = await s.setStatus(s.agentA, reviewToken, {
    status: "review"
  });
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.equal(reviewed.json().task.status, "review");
  const blockTask = await s.createTask("Straight to blocked");
  const blockToken = await s.claim(s.agentA, blockTask.id);
  assert.equal((await s.block(s.agentA, blockToken)).task.status, "blocked");
});

withSetup("status requests are validated", async (s) => {
  const task = await s.createTask("Validate");
  const other = await s.createTask("Other");
  const token = await s.claim(s.agentA, task.id);
  const expectError = async (body: object, status: number, code: string) => {
    const response = await s.setStatus(s.agentA, token, body);
    assert.equal(response.statusCode, status, response.body);
    assert.equal(response.json().error.code, code, response.body);
  };
  await expectError({ status: "blocked" }, 400, "VALIDATION_ERROR");
  await expectError(
    { status: "blocked", reason: "   " },
    400,
    "VALIDATION_ERROR"
  );
  await expectError(
    { status: "blocked", reason: "x".repeat(501) },
    400,
    "VALIDATION_ERROR"
  );
  await expectError(
    { status: "in_progress", blocked_on: { type: "agent", id: s.agentB.id } },
    400,
    "VALIDATION_ERROR"
  );
  await expectError(
    { status: "review", blocking_task_id: other.id },
    400,
    "VALIDATION_ERROR"
  );
  await expectError({ status: "done" }, 400, "VALIDATION_ERROR");
  const wrongToken = await s.setStatus(s.agentA, `claim_${"x".repeat(40)}`, {
    status: "in_progress"
  });
  assert.equal(wrongToken.statusCode, 404, wrongToken.body);
  assert.equal(wrongToken.json().error.code, "CLAIM_NOT_FOUND");
  const notOwner = await s.asAgent(
    s.agentB,
    "POST",
    `/sessions/${s.agentB.sessionId}/claims/status`,
    { claim_token: token, status: "in_progress" }
  );
  assert.equal(notOwner.statusCode, 403, notOwner.body);
  assert.equal(notOwner.json().error.code, "CLAIM_NOT_OWNER");
  // Nothing above changed the task.
  assert.equal((await s.taskRow(task.id)).status, "claimed");
  assert.equal((await s.blocksOf(task.id)).length, 0);

  // A claimed task pushed out of the claimant statuses is an invalid transition.
  await s.db
    .update(tasks)
    .set({ status: "review" })
    .where(eq(tasks.id, task.id));
  await expectError(
    { status: "in_progress" },
    409,
    "INVALID_STATUS_TRANSITION"
  );
});

withSetup(
  "blocking tasks must be in the project, open and acyclic",
  async (s) => {
    const first = await s.createTask("First");
    const second = await s.createTask("Second");
    const finished = await s.createTask("Finished");
    const foreign = await s.createTask("Foreign", s.otherProject.id);
    assert.equal((await s.move(finished.id, "done")).statusCode, 200);
    const firstToken = await s.claim(s.agentA, first.id);
    const secondToken = await s.claim(s.agentB, second.id);
    const attempt = (agent: Agent, token: string, blockingTaskId: string) =>
      s.setStatus(agent, token, {
        status: "blocked",
        reason: "waiting",
        blocking_task_id: blockingTaskId
      });
    const self = await attempt(s.agentA, firstToken, first.id);
    assert.equal(self.statusCode, 409, self.body);
    assert.equal(self.json().error.code, "BLOCKER_CYCLE");
    const crossProject = await attempt(s.agentA, firstToken, foreign.id);
    assert.equal(crossProject.statusCode, 404, crossProject.body);
    const missing = await attempt(
      s.agentA,
      firstToken,
      "00000000-0000-4000-8000-000000000000"
    );
    assert.equal(missing.statusCode, 404, missing.body);
    const done = await attempt(s.agentA, firstToken, finished.id);
    assert.equal(done.statusCode, 400, done.body);
    assert.equal(done.json().error.code, "VALIDATION_ERROR");

    const forward = await attempt(s.agentA, firstToken, second.id);
    assert.equal(forward.statusCode, 200, forward.body);
    const cycle = await attempt(s.agentB, secondToken, first.id);
    assert.equal(cycle.statusCode, 409, cycle.body);
    assert.equal(cycle.json().error.code, "BLOCKER_CYCLE");
    assert.equal((await s.taskRow(second.id)).status, "claimed");
    assert.equal((await s.blocksOf(second.id)).length, 0);
  }
);

withSetup("blocked_on must be another message candidate", async (s) => {
  const task = await s.createTask("Blocked on");
  const token = await s.claim(s.agentA, task.id);
  const foreign = await s.createAgent("foreign", s.otherProject.id);
  const revoked = await s.createAgent("revoked");
  assert.equal(
    (
      await s.asHuman(
        "alice",
        "POST",
        `/projects/${s.project.id}/agents/${revoked.id}/revoke`
      )
    ).statusCode,
    200
  );
  for (const blockedOn of [
    { type: "agent", id: s.agentA.id },
    { type: "agent", id: foreign.id },
    { type: "agent", id: revoked.id },
    { type: "human", id: "00000000-0000-4000-8000-000000000000" }
  ]) {
    const response = await s.setStatus(s.agentA, token, {
      status: "blocked",
      reason: "waiting",
      blocked_on: blockedOn
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, "VALIDATION_ERROR");
  }
  assert.equal((await s.blocksOf(task.id)).length, 0);
  const human = await s.block(s.agentA, token, {
    blocked_on: { type: "human", id: s.bob.id }
  });
  assert.equal(human.block.blocked_on.name, "bob");
});

withSetup(
  "lease expiry sends in_progress to ready and leaves blocked alone",
  async (s) => {
    const working = await s.createTask("Working");
    const waiting = await s.createTask("Waiting");
    const workingToken = await s.claim(s.agentA, working.id);
    const waitingToken = await s.claim(s.agentA, waiting.id);
    await s.setStatus(s.agentA, workingToken, { status: "in_progress" });
    await s.block(s.agentA, waitingToken);
    await s.db
      .update(taskClaims)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(taskClaims.agentId, s.agentA.id));
    // The lapsed lease is expired and committed before CLAIM_NOT_FOUND.
    const late = await s.setStatus(s.agentA, workingToken, {
      status: "review"
    });
    assert.equal(late.statusCode, 409, late.body);
    assert.equal(late.json().error.code, "CLAIM_NOT_FOUND");
    assert.equal((await s.taskRow(working.id)).status, "ready");
    // Reads reconcile the other expired claim.
    assert.equal(
      (await s.asHuman("alice", "GET", `/tasks/${waiting.id}`)).statusCode,
      200
    );
    const claims = await s.db
      .select()
      .from(taskClaims)
      .where(eq(taskClaims.agentId, s.agentA.id));
    assert.deepEqual(
      claims.map((claim) => claim.status),
      ["expired", "expired"]
    );
    assert.equal((await s.taskRow(waiting.id)).status, "blocked");
    const [open] = await s.blocksOf(waiting.id);
    assert.equal(open.resolvedAt, null);
    // Nobody can claim a blocked task until it is unblocked.
    const reclaim = await s.asAgent(
      s.agentB,
      "POST",
      `/tasks/${waiting.id}/claim`,
      {
        session_id: s.agentB.sessionId,
        lease_seconds: 300
      }
    );
    assert.equal(reclaim.statusCode, 409, reclaim.body);
    assert.equal(reclaim.json().error.code, "TASK_NOT_CLAIMABLE");
  }
);

withSetup(
  "session close and revoke send in_progress to ready and keep blocked",
  async (s) => {
    for (const end of ["close", "revoke"] as const) {
      const agent = await s.createAgent(`ender-${end}`);
      const working = await s.createTask(`Working ${end}`);
      const waiting = await s.createTask(`Waiting ${end}`);
      const workingToken = await s.claim(agent, working.id);
      const waitingToken = await s.claim(agent, waiting.id);
      await s.setStatus(agent, workingToken, { status: "in_progress" });
      await s.block(agent, waitingToken);
      const ended =
        end === "close"
          ? await s.asAgent(agent, "POST", `/sessions/${agent.sessionId}/close`)
          : await s.asHuman(
              "alice",
              "POST",
              `/projects/${s.project.id}/agents/${agent.id}/revoke`
            );
      assert.equal(ended.statusCode, 200, ended.body);
      assert.equal((await s.taskRow(working.id)).status, "ready", end);
      assert.equal((await s.taskRow(waiting.id)).status, "blocked", end);
      const [open] = await s.blocksOf(waiting.id);
      assert.equal(open.resolvedAt, null, end);
    }
  }
);

withSetup(
  "completing the blocking task resolves the block to in_progress",
  async (s) => {
    const blocker = await s.createTask("Blocker");
    const task = await s.createTask("Waiting on blocker");
    const blockerToken = await s.claim(s.agentB, blocker.id);
    const token = await s.claim(s.agentA, task.id);
    const blocked = await s.block(s.agentA, token, {
      blocking_task_id: blocker.id
    });
    const completed = await s.endClaim(s.agentB, "complete", blockerToken);
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal((await s.taskRow(task.id)).status, "in_progress");
    const [blockRow] = await s.blocksOf(task.id);
    assert.equal(blockRow.resolution, "blocking_task_done");
    assert.equal(blockRow.resolvedByAgentId, s.agentB.id);
    assert.equal(blockRow.resolutionSeenAt, null);
    const events = await s.eventsFor(task.id, [
      "task.block_resolved",
      "task.status_changed"
    ]);
    assert.deepEqual(
      events
        .slice(-2)
        .map((event) => [event.type, event.actorAgentId, event.payload]),
      [
        [
          "task.block_resolved",
          s.agentB.id,
          {
            block_id: blocked.block.id,
            resolution: "blocking_task_done",
            to_status: "in_progress"
          }
        ],
        [
          "task.status_changed",
          s.agentB.id,
          {
            from_status: "blocked",
            to_status: "in_progress",
            claim_id: blocked.claim.id
          }
        ]
      ]
    );
    // The creator sees the resolution until it sets a status.
    const pending = await s.summary(s.agentA);
    assert.deepEqual(
      pending.blockers_resolved.map((item: any) => [
        item.block_id,
        item.resolution
      ]),
      [[blocked.block.id, "blocking_task_done"]]
    );
    const resumed = await s.setStatus(s.agentA, token, {
      status: "in_progress"
    });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal((await s.summary(s.agentA)).blockers_resolved.length, 0);
    // The completion claim event carries no release reason.
    const [claimEvent] = await s.eventsFor(completed.json().claim.id, [
      "claim.completed"
    ]);
    assert.deepEqual(claimEvent.payload, {
      task_id: blocker.id,
      session_id: s.agentB.sessionId
    });
  }
);

withSetup(
  "a human move of the blocking task to done or cancelled resolves blocks",
  async (s) => {
    for (const [status, resolution] of [
      ["done", "blocking_task_done"],
      ["cancelled", "blocking_task_cancelled"]
    ] as const) {
      const agent = await s.createAgent(`mover-${status}`);
      const blocker = await s.createTask(`Blocker ${status}`);
      const claimed = await s.createTask(`Claimed ${status}`);
      const orphaned = await s.createTask(`Orphaned ${status}`);
      const claimedToken = await s.claim(s.agentA, claimed.id);
      const orphanedToken = await s.claim(agent, orphaned.id);
      await s.block(s.agentA, claimedToken, { blocking_task_id: blocker.id });
      await s.block(agent, orphanedToken, { blocking_task_id: blocker.id });
      // The orphaned task's session ends; its block survives.
      await s.asAgent(agent, "POST", `/sessions/${agent.sessionId}/close`);
      assert.equal((await s.taskRow(orphaned.id)).status, "blocked");
      const moved = await s.move(blocker.id, status);
      assert.equal(moved.statusCode, 200, moved.body);
      assert.equal((await s.taskRow(claimed.id)).status, "in_progress", status);
      assert.equal((await s.taskRow(orphaned.id)).status, "ready", status);
      for (const taskId of [claimed.id, orphaned.id]) {
        const [blockRow] = await s.blocksOf(taskId);
        assert.equal(blockRow.resolution, resolution);
        assert.ok(blockRow.resolvedByUserId);
      }
      const [event] = (
        await s.eventsFor(orphaned.id, ["task.status_changed"])
      ).slice(-1);
      assert.deepEqual(event.payload, {
        from_status: "blocked",
        to_status: "ready",
        claim_id: null
      });
      // Release the claimed one for the next round.
      await s.endClaim(s.agentA, "release", claimedToken);
    }
  }
);

withSetup(
  "a comment from the blocked_on participant resolves the block",
  async (s) => {
    const task = await s.createTask("Question");
    const token = await s.claim(s.agentA, task.id);
    const blocked = await s.block(s.agentA, token, {
      blocked_on: { type: "agent", id: s.agentB.id }
    });
    // Someone else answering does not resolve it.
    const other = await s.asHuman("bob", "POST", `/tasks/${task.id}/comments`, {
      body_markdown: "not me"
    });
    assert.equal(other.statusCode, 201, other.body);
    assert.equal((await s.taskRow(task.id)).status, "blocked");
    const answer = await s.asAgent(
      s.agentB,
      "POST",
      `/tasks/${task.id}/comments`,
      {
        body_markdown: "here is the answer"
      }
    );
    assert.equal(answer.statusCode, 201, answer.body);
    assert.equal((await s.taskRow(task.id)).status, "in_progress");
    const [blockRow] = await s.blocksOf(task.id);
    assert.equal(blockRow.id, blocked.block.id);
    assert.equal(blockRow.resolution, "participant_responded");
    assert.equal(blockRow.resolvedByAgentId, s.agentB.id);

    // A human blocked_on works the same way, and the task goes back to ready
    // when no claim is active.
    const humanTask = await s.createTask("Ask bob");
    const agent = await s.createAgent("asker");
    const humanToken = await s.claim(agent, humanTask.id);
    await s.block(agent, humanToken, {
      blocked_on: { type: "human", id: s.bob.id }
    });
    await s.asAgent(agent, "POST", `/sessions/${agent.sessionId}/close`);
    const reply = await s.asHuman(
      "bob",
      "POST",
      `/tasks/${humanTask.id}/comments`,
      {
        body_markdown: "answered"
      }
    );
    assert.equal(reply.statusCode, 201, reply.body);
    assert.equal((await s.taskRow(humanTask.id)).status, "ready");
    const [humanBlock] = await s.blocksOf(humanTask.id);
    assert.equal(humanBlock.resolution, "participant_responded");
    assert.equal(humanBlock.resolvedByUserId, s.bob.id);
  }
);

withSetup("a human resolves a blocker", async (s) => {
  const task = await s.createTask("Resolve me");
  const token = await s.claim(s.agentA, task.id);
  const blocked = await s.block(s.agentA, token);
  const resolved = await s.asHuman(
    "bob",
    "POST",
    `/tasks/${task.id}/block/resolve`
  );
  assert.equal(resolved.statusCode, 200, resolved.body);
  const body = resolved.json();
  assert.equal(body.id, blocked.block.id);
  assert.equal(body.resolution, "resolved_by_human");
  assert.ok(body.resolved_at);
  assert.equal((await s.taskRow(task.id)).status, "in_progress");
  const [event] = await s.eventsFor(task.id, ["task.block_resolved"]);
  assert.equal(event.actorUserId, s.bob.id);
  assert.equal(event.actorAgentId, null);
  const again = await s.asHuman(
    "bob",
    "POST",
    `/tasks/${task.id}/block/resolve`
  );
  assert.equal(again.statusCode, 404, again.body);
  const missing = await s.asHuman(
    "bob",
    "POST",
    "/tasks/00000000-0000-4000-8000-000000000000/block/resolve"
  );
  assert.equal(missing.statusCode, 404, missing.body);
  const foreign = await s.createTask("Foreign", s.otherProject.id);
  const denied = await s.asHuman(
    "bob",
    "POST",
    `/tasks/${foreign.id}/block/resolve`
  );
  assert.equal(denied.statusCode, 403, denied.body);
});

withSetup(
  "move rejects actively claimed tasks and moving out of blocked resolves",
  async (s) => {
    const working = await s.createTask("Working");
    const waiting = await s.createTask("Waiting");
    const agent = await s.createAgent("mover");
    const workingToken = await s.claim(agent, working.id);
    const waitingToken = await s.claim(agent, waiting.id);
    for (const [taskId, token, body] of [
      [working.id, workingToken, { status: "in_progress" }],
      [waiting.id, waitingToken, { status: "blocked", reason: "waiting" }]
    ] as const) {
      assert.equal((await s.setStatus(agent, token, body)).statusCode, 200);
      const refused = await s.move(taskId, "done");
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(refused.json().error.code, "TASK_NOT_CLAIMABLE");
    }
    // After the session ends the blocked task can be moved; that resolves it.
    await s.asAgent(agent, "POST", `/sessions/${agent.sessionId}/close`);
    const moved = await s.move(waiting.id, "backlog");
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal((await s.taskRow(waiting.id)).status, "backlog");
    const [blockRow] = await s.blocksOf(waiting.id);
    assert.equal(blockRow.resolution, "moved_by_human");
    const [event] = await s.eventsFor(waiting.id, ["task.block_resolved"]);
    assert.deepEqual(event.payload, {
      block_id: blockRow.id,
      resolution: "moved_by_human",
      to_status: "backlog"
    });
  }
);

withSetup("release and completion close the task's own block", async (s) => {
  const released = await s.createTask("Release while blocked");
  const releasedToken = await s.claim(s.agentA, released.id);
  await s.block(s.agentA, releasedToken);
  const release = await s.endClaim(s.agentA, "release", releasedToken);
  assert.equal(release.statusCode, 200, release.body);
  assert.equal((await s.taskRow(released.id)).status, "ready");
  const [releasedBlock] = await s.blocksOf(released.id);
  assert.equal(releasedBlock.resolution, "released");
  const [releaseEvent] = await s.eventsFor(release.json().claim.id, [
    "claim.released"
  ]);
  assert.equal(releaseEvent.payload.reason, "agent_release");

  const completed = await s.createTask("Complete while blocked");
  const completedToken = await s.claim(s.agentA, completed.id);
  await s.block(s.agentA, completedToken);
  const complete = await s.endClaim(s.agentA, "complete", completedToken);
  assert.equal(complete.statusCode, 200, complete.body);
  assert.equal((await s.taskRow(completed.id)).status, "done");
  const [completedBlock] = await s.blocksOf(completed.id);
  assert.equal(completedBlock.resolution, "status_changed");
  // Resolving its own block leaves the creator nothing to acknowledge.
  assert.equal((await s.summary(s.agentA)).blockers_resolved.length, 0);
});
