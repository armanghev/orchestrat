import assert from "node:assert/strict";
import test from "node:test";
import {
  chatParticipants,
  handoffs,
  organizationMembers,
  projectEvents,
  taskBlocks,
  taskClaims,
  taskWatches,
  tasks,
  users
} from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
import { fixture } from "../test/fixture.js";

type Setup = Awaited<ReturnType<typeof setup>>;
let keys = 0;
const nextKey = () => `attention-${++keys}`;
const human = (name: "alice" | "bob") => ({ authorization: `Bearer ${name}` });

async function setup() {
  const { app, db } = await fixture();
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: human("alice"),
      payload: { name: "Attention" }
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
  const project = await createProject("Attention project");
  const otherProject = await createProject("Other project");
  await app.inject({
    method: "GET",
    url: "/api/v1/profile",
    headers: human("bob")
  });
  const [alice] = await db
    .select()
    .from(users)
    .where(eq(users.email, "alice@example.com"));
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
  const createTask = async (title: string, status = "ready") => {
    const response = await asHuman(
      "alice",
      "POST",
      `/projects/${project.id}/tasks`,
      {
        title,
        status
      }
    );
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as { id: string; key: string };
  };
  const agentComment = async (
    agent: { token: string },
    taskId: string,
    body: string,
    mentions: { type: "human" | "agent"; id: string }[] = []
  ) => {
    const response = await asAgent(agent, "POST", `/tasks/${taskId}/comments`, {
      body_markdown: body,
      mentions
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json();
  };
  const claim = async (
    agent: { token: string; sessionId: string },
    taskId: string
  ) => {
    const response = await asAgent(agent, "POST", `/tasks/${taskId}/claim`, {
      session_id: agent.sessionId,
      lease_seconds: 300
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().claim_token as string;
  };
  const endClaim = (
    agent: { token: string; sessionId: string },
    action: "complete" | "release",
    claimToken: string,
    acknowledgedThrough?: number
  ) =>
    asAgent(agent, "POST", `/sessions/${agent.sessionId}/claims/${action}`, {
      claim_token: claimToken,
      ...(acknowledgedThrough === undefined
        ? {}
        : { acknowledged_through: acknowledgedThrough })
    });
  const summary = async (agent: { token: string }) => {
    const response = await asAgent(agent, "GET", "/attention");
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const watchOf = async (
    taskId: string,
    actor: { agentId?: string; userId?: string }
  ) =>
    (
      await db
        .select()
        .from(taskWatches)
        .where(
          and(
            eq(taskWatches.taskId, taskId),
            actor.agentId
              ? eq(taskWatches.agentId, actor.agentId)
              : eq(taskWatches.userId, actor.userId!)
          )
        )
    )[0];
  return {
    app,
    db,
    project,
    otherProject,
    alice,
    bob,
    agentA,
    agentB,
    createAgent,
    asAgent,
    asHuman,
    createTask,
    agentComment,
    claim,
    endClaim,
    summary,
    watchOf
  };
}

const withSetup = (name: string, body: (s: Setup) => Promise<void>) =>
  test(name, async (t) => {
    const s = await setup();
    t.after(() => s.app.close());
    await body(s);
  });

withSetup(
  "comment sequences are contiguous per task and carry mentions",
  async (s) => {
    const first = await s.createTask("First");
    const second = await s.createTask("Second");
    const one = await s.agentComment(s.agentA, first.id, "one");
    const human = await s.asHuman(
      "bob",
      "POST",
      `/tasks/${first.id}/comments`,
      {
        body_markdown: "two",
        mentions: [{ type: "agent", id: s.agentA.id }]
      }
    );
    assert.equal(human.statusCode, 201, human.body);
    const three = await s.agentComment(s.agentB, first.id, "three");
    const other = await s.agentComment(s.agentB, second.id, "other");
    assert.deepEqual(
      [one.sequence, human.json().sequence, three.sequence, other.sequence],
      [1, 2, 3, 1]
    );
    assert.deepEqual(human.json().mentions, [
      { type: "agent", id: s.agentA.id, name: "agent-a" }
    ]);
    const listed = await s.asAgent(
      s.agentA,
      "GET",
      `/tasks/${first.id}/comments`
    );
    assert.deepEqual(
      listed
        .json()
        .comments.map((comment: any) => [
          comment.sequence,
          comment.mentions.length
        ]),
      [
        [1, 0],
        [2, 1],
        [3, 0]
      ]
    );
    // An idempotent replay returns the stored comment without a new sequence.
    const replay = await s.app.inject({
      method: "POST",
      url: `/api/v1/agent/tasks/${first.id}/comments`,
      headers: {
        authorization: `Bearer ${s.agentA.token}`,
        "idempotency-key": "replayed-comment"
      },
      payload: { body_markdown: "four" }
    });
    const again = await s.app.inject({
      method: "POST",
      url: `/api/v1/agent/tasks/${first.id}/comments`,
      headers: {
        authorization: `Bearer ${s.agentA.token}`,
        "idempotency-key": "replayed-comment"
      },
      payload: { body_markdown: "four" }
    });
    assert.equal(replay.json().sequence, 4);
    assert.equal(again.json().sequence, 4);
    const events = await s.db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.type, "task.comment_created"));
    const mentioned = events.find(
      (event) => event.entityId === human.json().id
    );
    assert.deepEqual(mentioned?.payload, {
      task_id: first.id,
      sequence: 2,
      mentions: [{ type: "agent", id: s.agentA.id }]
    });
  }
);

withSetup("comment mentions must be project candidates", async (s) => {
  const task = await s.createTask("Mentions");
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
  const post = (mentions: unknown[]) =>
    s.asAgent(s.agentA, "POST", `/tasks/${task.id}/comments`, {
      body_markdown: "hello",
      mentions
    });
  for (const mentions of [
    [{ type: "human", id: "00000000-0000-4000-8000-000000000000" }],
    [{ type: "agent", id: foreign.id }],
    [{ type: "agent", id: revoked.id }],
    Array.from({ length: 21 }, () => ({ type: "agent", id: s.agentB.id }))
  ]) {
    const response = await post(mentions);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, "VALIDATION_ERROR");
  }
  const accepted = await post([
    { type: "agent", id: s.agentB.id },
    { type: "agent", id: s.agentB.id },
    { type: "human", id: s.bob.id }
  ]);
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.deepEqual(accepted.json().mentions, [
    { type: "agent", id: s.agentB.id, name: "agent-b" },
    { type: "human", id: s.bob.id, name: "bob" }
  ]);
  // Rejected comments never consumed a sequence.
  assert.equal(accepted.json().sequence, 1);
});

withSetup("direct chats accept mentions of their participants", async (s) => {
  const direct = await s.asAgent(s.agentA, "POST", "/chats", {
    kind: "direct",
    participants: [{ type: "agent", id: s.agentB.id }]
  });
  assert.equal(direct.statusCode, 201, direct.body);
  const sent = await s.asAgent(
    s.agentA,
    "POST",
    `/chats/${direct.json().id}/messages`,
    {
      body_markdown: "@agent-b ping",
      mentions: [{ type: "agent", id: s.agentB.id }]
    }
  );
  assert.equal(sent.statusCode, 201, sent.body);
  const attention = await s.summary(s.agentB);
  assert.deepEqual(attention.unread_chats, [
    { chat_id: direct.json().id, unread_count: 1, mention_count: 1 }
  ]);
});

withSetup(
  "automatic watches follow create, claim, comment and mention; mute is sticky",
  async (s) => {
    const task = await s.createTask("Watched");
    assert.equal(
      (await s.watchOf(task.id, { userId: s.alice.id }))?.reason,
      "created"
    );
    await s.agentComment(s.agentB, task.id, "before claim");
    await s.claim(s.agentA, task.id);
    const claimed = await s.watchOf(task.id, { agentId: s.agentA.id });
    assert.equal(claimed?.reason, "claimed");
    assert.equal(claimed?.claimBaselineSequence, 1);
    assert.equal(claimed?.lastReadSequence, 0);
    const commenter = await s.watchOf(task.id, { agentId: s.agentB.id });
    assert.equal(commenter?.reason, "commented");
    assert.equal(commenter?.lastReadSequence, 0);
    await s.agentComment(s.agentB, task.id, "hey bob", [
      { type: "human", id: s.bob.id }
    ]);
    const bobWatch = await s.watchOf(task.id, { userId: s.bob.id });
    assert.equal(bobWatch?.reason, "mentioned");
    assert.equal(bobWatch?.lastReadSequence, 1);

    // Agent-created tasks watch their creator too.
    const own = await s.asAgent(s.agentB, "POST", "/tasks", {
      title: "Mine",
      status: "ready"
    });
    assert.equal(own.statusCode, 201, own.body);
    assert.equal(
      (await s.watchOf(own.json().id, { agentId: s.agentB.id }))?.reason,
      "created"
    );

    // Muting is sticky: later comments and mentions never re-enable it.
    const muted = await s.createTask("Muted");
    const mute = await s.asAgent(s.agentA, "POST", `/tasks/${muted.id}/watch`, {
      watching: false
    });
    assert.equal(mute.statusCode, 200, mute.body);
    assert.deepEqual(mute.json(), {
      task_id: muted.id,
      state: "muted",
      reason: "explicit",
      last_read_sequence: 0
    });
    await s.agentComment(s.agentB, muted.id, "plain");
    await s.agentComment(s.agentB, muted.id, "@agent-a look", [
      { type: "agent", id: s.agentA.id }
    ]);
    await s.agentComment(s.agentA, muted.id, "my own note");
    assert.equal(
      (await s.watchOf(muted.id, { agentId: s.agentA.id }))?.state,
      "muted"
    );
    const attention = await s.summary(s.agentA);
    const item = attention.tasks.find(
      (value: any) => value.task_id === muted.id
    );
    assert.ok(item, "a muted task still surfaces its mention");
    assert.equal(item.watching, false);
    assert.equal(item.mention_count, 1);
    assert.equal(item.unread_count, 1);
    assert.deepEqual(
      item.unread.map((value: any) => [value.sequence, value.mentions_you]),
      [[2, true]]
    );
    // Explicit watch flips it back.
    const rewatch = await s.asAgent(
      s.agentA,
      "POST",
      `/tasks/${muted.id}/watch`,
      {
        watching: true
      }
    );
    assert.equal(rewatch.json().state, "watching");
    const unknown = await s.asAgent(
      s.agentA,
      "POST",
      `/tasks/${s.otherProject.id}/watch`,
      {
        watching: true
      }
    );
    assert.equal(unknown.statusCode, 404);
  }
);

withSetup(
  "agent summary excludes own comments and acknowledge advances read state",
  async (s) => {
    const created = await s.asAgent(s.agentA, "POST", "/tasks", {
      title: "Summary",
      status: "ready"
    });
    const task = created.json();
    await s.agentComment(
      s.agentB,
      task.id,
      `first\n\n  with   ${"long ".repeat(100)}`
    );
    await s.agentComment(s.agentA, task.id, "own comment");
    await s.agentComment(s.agentB, task.id, "second");
    let attention = await s.summary(s.agentA);
    assert.match(attention.cursor, /^[0-9]+$/);
    assert.equal(attention.branch_id, null);
    assert.equal(attention.truncated, false);
    assert.equal(attention.tasks.length, 1);
    const [item] = attention.tasks;
    assert.equal(item.task_id, task.id);
    assert.equal(item.key, task.key);
    assert.equal(item.watching, true);
    assert.equal(item.claimed_by_you, false);
    assert.equal(item.unread_count, 2);
    assert.equal(item.blocking_unread_count, 0);
    assert.equal(item.latest_sequence, 3);
    assert.deepEqual(
      item.unread.map((value: any) => value.sequence),
      [1, 3]
    );
    assert.ok(item.unread[0].excerpt.length <= 280);
    assert.doesNotMatch(item.unread[0].excerpt, /\s{2}|\n/);
    assert.deepEqual(item.unread[0].author, {
      type: "agent",
      id: s.agentB.id,
      name: "agent-b"
    });
    // B's own comments never count; only A's note is unread for B.
    const forB = (await s.summary(s.agentB)).tasks;
    assert.deepEqual(
      forB.map((value: any) => [value.unread_count, value.unread[0].sequence]),
      [[1, 2]]
    );

    const acknowledge = (agent: { token: string }, items: unknown[]) =>
      s.asAgent(agent, "POST", "/attention/acknowledge", { items });
    const tooFar = await acknowledge(s.agentA, [
      { type: "task_comments", task_id: task.id, through_sequence: 4 }
    ]);
    assert.equal(tooFar.statusCode, 400, tooFar.body);
    const partial = await acknowledge(s.agentA, [
      { type: "task_comments", task_id: task.id, through_sequence: 1 }
    ]);
    assert.deepEqual(partial.json(), { acknowledged: 1 });
    attention = await s.summary(s.agentA);
    assert.equal(attention.tasks[0].unread_count, 1);
    assert.equal(attention.tasks[0].last_read_sequence, 1);
    await acknowledge(s.agentA, [
      { type: "task_comments", task_id: task.id, through_sequence: 3 }
    ]);
    // Acknowledging an older sequence never moves the read position back.
    await acknowledge(s.agentA, [
      { type: "task_comments", task_id: task.id, through_sequence: 2 }
    ]);
    assert.equal(
      (await s.watchOf(task.id, { agentId: s.agentA.id }))?.lastReadSequence,
      3
    );
    assert.deepEqual((await s.summary(s.agentA)).tasks, []);

    // Handoffs are pending while the recipient's chat read position is behind.
    const direct = (
      await s.asAgent(s.agentB, "POST", "/chats", {
        kind: "direct",
        participants: [{ type: "agent", id: s.agentA.id }]
      })
    ).json();
    const message = (
      await s.asAgent(s.agentB, "POST", `/chats/${direct.id}/messages`, {
        body_markdown: "Please take over the summary task."
      })
    ).json();
    const [handoff] = await s.db
      .insert(handoffs)
      .values({
        projectId: s.project.id,
        chatId: direct.id,
        messageId: message.id,
        messageSequence: message.sequence,
        fromAgentId: s.agentB.id,
        toAgentId: s.agentA.id,
        taskId: task.id,
        chainId: "00000000-0000-4000-8000-00000000c0de",
        hop: 1
      })
      .returning();
    attention = await s.summary(s.agentA);
    assert.deepEqual(attention.handoffs, [
      {
        handoff_id: handoff.id,
        from: { type: "agent", id: s.agentB.id, name: "agent-b" },
        chat_id: direct.id,
        message_id: message.id,
        sequence: message.sequence,
        task: { id: task.id, key: task.key, title: "Summary" },
        excerpt: "Please take over the summary task.",
        created_at: handoff.createdAt.toISOString(),
        hop: 1
      }
    ]);
    assert.equal(
      (
        await acknowledge(s.agentB, [
          { type: "handoff", handoff_id: handoff.id }
        ])
      ).statusCode,
      404
    );
    assert.equal(
      (
        await acknowledge(s.agentA, [
          { type: "handoff", handoff_id: handoff.id }
        ])
      ).statusCode,
      200
    );
    attention = await s.summary(s.agentA);
    assert.deepEqual(attention.handoffs, []);
    assert.deepEqual(attention.unread_chats, []);
    const [participant] = await s.db
      .select()
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, direct.id),
          eq(chatParticipants.agentId, s.agentA.id)
        )
      );
    assert.equal(participant.lastReadSequence, message.sequence);

    // Resolved blockers stay until their creator acknowledges them.
    const [open] = await s.db
      .insert(taskBlocks)
      .values({
        projectId: s.project.id,
        taskId: task.id,
        createdByType: "agent",
        createdByAgentId: s.agentA.id,
        reason: "Waiting on B"
      })
      .returning();
    assert.equal(
      (await acknowledge(s.agentA, [{ type: "blocker", block_id: open.id }]))
        .statusCode,
      409
    );
    const resolvedAt = new Date();
    await s.db
      .update(taskBlocks)
      .set({
        resolvedAt,
        resolution: "resolved_by_human",
        resolvedByUserId: s.alice.id
      })
      .where(eq(taskBlocks.id, open.id));
    attention = await s.summary(s.agentA);
    assert.deepEqual(attention.blockers_resolved, [
      {
        block_id: open.id,
        task: { id: task.id, key: task.key, title: "Summary" },
        resolution: "resolved_by_human",
        resolved_at: resolvedAt.toISOString()
      }
    ]);
    assert.equal(
      (await acknowledge(s.agentB, [{ type: "blocker", block_id: open.id }]))
        .statusCode,
      404
    );
    assert.equal(
      (await acknowledge(s.agentA, [{ type: "blocker", block_id: open.id }]))
        .statusCode,
      200
    );
    assert.deepEqual((await s.summary(s.agentA)).blockers_resolved, []);
  }
);

withSetup(
  "human summary, task overlays and comment read positions",
  async (s) => {
    const task = await s.createTask("Human view");
    await s.claim(s.agentA, task.id);
    await s.agentComment(s.agentA, task.id, "@bob can you check?", [
      { type: "human", id: s.bob.id }
    ]);
    await s.agentComment(s.agentB, task.id, "follow-up");
    const bobSummary = await s.asHuman(
      "bob",
      "GET",
      `/projects/${s.project.id}/attention`
    );
    assert.equal(bobSummary.statusCode, 200, bobSummary.body);
    const [item] = bobSummary.json().tasks;
    assert.equal(item.task_id, task.id);
    assert.equal(item.unread_count, 2);
    assert.equal(item.mention_count, 1);
    assert.equal(item.claimed_by_you, false);
    const aliceOverlays = await s.asHuman(
      "alice",
      "GET",
      `/projects/${s.project.id}/attention/tasks`
    );
    assert.equal(aliceOverlays.statusCode, 200, aliceOverlays.body);
    const overlay = aliceOverlays
      .json()
      .tasks.find((value: any) => value.task_id === task.id);
    assert.equal(overlay.watching, true);
    assert.equal(overlay.unread_count, 2);
    assert.equal(overlay.mention_count, 0);
    assert.equal(overlay.claim.agent_id, s.agentA.id);
    assert.equal(overlay.claim.agent_name, "agent-a");
    assert.equal(overlay.claim.status, "active");
    assert.equal(overlay.block, null);

    const read = await s.asHuman(
      "bob",
      "POST",
      `/tasks/${task.id}/comments/read`,
      {
        through_sequence: 2
      }
    );
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(read.json(), {
      task_id: task.id,
      state: "watching",
      reason: "mentioned",
      last_read_sequence: 2
    });
    assert.deepEqual(
      (
        await s.asHuman("bob", "GET", `/projects/${s.project.id}/attention`)
      ).json().tasks,
      []
    );
    assert.equal(
      (
        await s.asHuman("bob", "POST", `/tasks/${task.id}/comments/read`, {
          through_sequence: 3
        })
      ).statusCode,
      400
    );
    const unwatch = await s.asHuman(
      "alice",
      "POST",
      `/tasks/${task.id}/watch`,
      {
        watching: false
      }
    );
    assert.equal(unwatch.json().state, "muted");
    const afterMute = (
      await s.asHuman(
        "alice",
        "GET",
        `/projects/${s.project.id}/attention/tasks`
      )
    )
      .json()
      .tasks.find((value: any) => value.task_id === task.id);
    assert.equal(afterMute.watching, false);
    assert.equal(afterMute.unread_count, 0);
    assert.equal(afterMute.claim.agent_id, s.agentA.id);
    // Humans outside the project are rejected.
    assert.equal(
      (
        await s.asHuman(
          "bob",
          "GET",
          `/projects/${s.otherProject.id}/attention`
        )
      ).statusCode,
      403
    );
    assert.equal(
      (
        await s.asHuman(
          "bob",
          "GET",
          `/projects/${s.otherProject.id}/attention/tasks`
        )
      ).statusCode,
      403
    );
  }
);

withSetup(
  "completion is guarded by unread comments from others (ORC-3)",
  async (s) => {
    const task = await s.createTask("Guarded");
    const token = await s.claim(s.agentA, task.id);
    for (const body of ["one", "two", "three"])
      await s.agentComment(s.agentB, task.id, body);
    const eventsBefore = (await s.db.select().from(projectEvents)).length;
    const blocked = await s.endClaim(s.agentA, "complete", token);
    assert.equal(blocked.statusCode, 409, blocked.body);
    const error = blocked.json().error;
    assert.equal(error.code, "TASK_COMMENTS_UNREAD");
    assert.equal(error.details.task_id, task.id);
    assert.equal(error.details.latest_sequence, 3);
    assert.equal(error.details.total_unread, 3);
    assert.deepEqual(
      error.details.unread.map((value: any) => [value.sequence, value.excerpt]),
      [
        [1, "one"],
        [2, "two"],
        [3, "three"]
      ]
    );
    const attention = await s.summary(s.agentA);
    assert.equal(attention.tasks[0].claimed_by_you, true);
    assert.equal(attention.tasks[0].blocking_unread_count, 3);

    const tooLow = await s.endClaim(s.agentA, "complete", token, 2);
    assert.equal(tooLow.statusCode, 409);
    const tooHigh = await s.endClaim(s.agentA, "complete", token, 4);
    assert.equal(tooHigh.statusCode, 400);
    const [stillActive] = await s.db
      .select()
      .from(taskClaims)
      .where(eq(taskClaims.taskId, task.id));
    assert.equal(stillActive.status, "active");
    const [stillClaimed] = await s.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id));
    assert.equal(stillClaimed.status, "claimed");
    assert.equal(
      (await s.watchOf(task.id, { agentId: s.agentA.id }))?.lastReadSequence,
      0
    );
    assert.equal(
      (await s.db.select().from(projectEvents)).length,
      eventsBefore
    );

    const done = await s.endClaim(s.agentA, "complete", token, 3);
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.json().claim.status, "completed");
    const [completed] = await s.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id));
    assert.equal(completed.status, "done");
    assert.equal(
      (await s.watchOf(task.id, { agentId: s.agentA.id }))?.lastReadSequence,
      3
    );
  }
);

withSetup(
  "pre-claim and own comments never block; release is guarded",
  async (s) => {
    const task = await s.createTask("Baseline");
    await s.agentComment(s.agentB, task.id, "before the claim");
    await s.asHuman("alice", "POST", `/tasks/${task.id}/comments`, {
      body_markdown: "also before"
    });
    // A resolved blocker from an earlier claim counts as seen once A reclaims.
    const [earlier] = await s.db
      .insert(taskBlocks)
      .values({
        projectId: s.project.id,
        taskId: task.id,
        createdByType: "agent",
        createdByAgentId: s.agentA.id,
        reason: "Earlier block",
        resolvedAt: new Date(),
        resolution: "released"
      })
      .returning();
    assert.equal((await s.summary(s.agentA)).blockers_resolved.length, 1);
    const token = await s.claim(s.agentA, task.id);
    const [seen] = await s.db
      .select()
      .from(taskBlocks)
      .where(eq(taskBlocks.id, earlier.id));
    assert.ok(seen.resolutionSeenAt);
    await s.agentComment(s.agentA, task.id, "my progress note");
    // Older unread comments remain attention without blocking.
    const attention = await s.summary(s.agentA);
    assert.deepEqual(attention.blockers_resolved, []);
    assert.equal(attention.tasks[0].unread_count, 2);
    assert.equal(attention.tasks[0].blocking_unread_count, 0);
    const released = await s.endClaim(s.agentA, "release", token);
    assert.equal(released.statusCode, 200, released.body);

    const guarded = await s.createTask("Release guard");
    const second = await s.claim(s.agentA, guarded.id);
    await s.asHuman("alice", "POST", `/tasks/${guarded.id}/comments`, {
      body_markdown: "wait, one more thing"
    });
    const refused = await s.endClaim(s.agentA, "release", second);
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(refused.json().error.code, "TASK_COMMENTS_UNREAD");
    assert.equal(refused.json().error.details.unread[0].author.type, "human");
    // Commenting does not advance the author's read position.
    await s.agentComment(s.agentA, guarded.id, "ack via comment");
    assert.equal(
      (await s.endClaim(s.agentA, "release", second)).statusCode,
      409
    );
    const ok = await s.endClaim(s.agentA, "release", second, 1);
    assert.equal(ok.statusCode, 200, ok.body);
    const [ready] = await s.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, guarded.id));
    assert.equal(ready.status, "ready");
  }
);
