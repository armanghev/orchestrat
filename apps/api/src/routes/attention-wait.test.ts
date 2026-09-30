import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  handoffs,
  organizationMembers,
  projectEvents,
  taskBlocks,
  users
} from "@orchestrat/db";
import {
  agentAttentionResponseSchema,
  waitQuerySchema,
  waitResponseSchema,
  type RealtimeEventEnvelope
} from "@orchestrat/protocol";
import { eq, max } from "drizzle-orm";
import { AttentionService } from "../services/attention-service.js";
import {
  AttentionWaitHub,
  waitLimitPerProject
} from "../services/attention-wait-hub.js";
import { ChatService } from "../services/chat-service.js";
import { fixture } from "../test/fixture.js";

type Setup = Awaited<ReturnType<typeof setup>>;
type Agent = { id: string; token: string; sessionId: string };
let keys = 0;
const nextKey = () => `wait-${++keys}`;
const human = (name: "alice" | "bob") => ({ authorization: `Bearer ${name}` });

async function setup() {
  const { app, db } = await fixture();
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: human("alice"),
      payload: { name: "Waits" }
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
  const project = await createProject("Wait project");
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

  const createAgent = async (name: string): Promise<Agent> => {
    const agent = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents`,
        headers: human("alice"),
        payload: { name }
      })
    ).json();
    const token = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents/${agent.id}/credentials`,
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
    return { id: agent.id, token, sessionId: session.id };
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
  const ok = async <T = any>(
    response: Promise<{ statusCode: number; body: string; json(): any }>,
    status = 200
  ) => {
    const value = await response;
    assert.equal(value.statusCode, status, value.body);
    return value.json() as T;
  };
  const humanTask = (title: string) =>
    ok<{ id: string; key: string; title: string; version: number }>(
      asHuman("alice", "POST", `/projects/${project.id}/tasks`, {
        title,
        status: "ready"
      }),
      201
    );
  const agentTask = (agent: Agent, title: string) =>
    ok<{ id: string; key: string; title: string; version: number }>(
      asAgent(agent, "POST", "/tasks", { title, status: "ready" }),
      201
    );
  const comment = (
    agent: Agent,
    taskId: string,
    body: string,
    mentions: { type: "human" | "agent"; id: string }[] = []
  ) =>
    ok(
      asAgent(agent, "POST", `/tasks/${taskId}/comments`, {
        body_markdown: body,
        mentions
      }),
      201
    );
  const claim = async (agent: Agent, taskId: string) =>
    (
      await ok(
        asAgent(agent, "POST", `/tasks/${taskId}/claim`, {
          session_id: agent.sessionId,
          lease_seconds: 300
        })
      )
    ).claim_token as string;
  const endClaim = (
    agent: Agent,
    action: "complete" | "release",
    token: string
  ) =>
    ok(
      asAgent(agent, "POST", `/sessions/${agent.sessionId}/claims/${action}`, {
        claim_token: token
      })
    );
  const chat = (agent: Agent, participants: Agent[], name?: string) =>
    ok<{ id: string }>(
      asAgent(agent, "POST", "/chats", {
        kind: name ? "group" : "direct",
        ...(name ? { name } : {}),
        participants: participants.map((value) => ({
          type: "agent",
          id: value.id
        }))
      }),
      201
    );
  const send = (
    agent: Agent,
    chatId: string,
    body: string,
    mentions: Agent[] = []
  ) =>
    ok<{ id: string; sequence: number }>(
      asAgent(agent, "POST", `/chats/${chatId}/messages`, {
        body_markdown: body,
        mentions: mentions.map((value) => ({ type: "agent", id: value.id }))
      }),
      201
    );
  const cursorOf = async (agent: Agent) =>
    (await ok<{ cursor: string }>(asAgent(agent, "GET", "/attention"))).cursor;
  // Dispatched at once (inject is lazy until awaited), so a wait can be
  // pending while the test triggers events.
  const wait = async (
    agent: { token: string },
    query: Record<string, string | number | boolean>
  ) =>
    asAgent(
      agent,
      "GET",
      `/attention/wait?${new URLSearchParams(
        Object.entries(query).map(([key, value]) => [key, String(value)])
      )}`
    );
  const waitOk = async (
    agent: Agent,
    query: Record<string, string | number | boolean>
  ) => waitResponseSchema.parse(await ok(wait(agent, query)));
  const maxEventId = async () =>
    String(
      (
        await db
          .select({ value: max(projectEvents.id) })
          .from(projectEvents)
          .where(eq(projectEvents.projectId, project.id))
      )[0]?.value ?? 0
    );
  const insertEvent = async (value: {
    type: string;
    actorAgentId?: string | null;
    actorUserId?: string | null;
    entityId?: string | null;
    payload: Record<string, unknown>;
  }) =>
    (
      await db
        .insert(projectEvents)
        .values({
          projectId: project.id,
          type: value.type,
          actorAgentId: value.actorAgentId ?? null,
          actorUserId: value.actorUserId ?? null,
          entityId: value.entityId ?? null,
          payload: value.payload
        })
        .returning()
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
    ok,
    humanTask,
    agentTask,
    comment,
    claim,
    endClaim,
    chat,
    send,
    cursorOf,
    wait,
    waitOk,
    maxEventId,
    insertEvent
  };
}

const withSetup = (name: string, body: (s: Setup) => Promise<void>) =>
  test(name, async (t) => {
    const s = await setup();
    t.after(() => s.app.close());
    await body(s);
  });

// A hub over the same database, for event types whose producers belong to
// other work packages: the test inserts the event and publishes it itself.
const directHub = (s: Setup) =>
  new AttentionWaitHub(new AttentionService(s.db, new ChatService(s.db)), s.db);
const envelope = (
  event: typeof projectEvents.$inferSelect
): RealtimeEventEnvelope => ({
  project_id: event.projectId,
  sequence: event.id,
  event_type: event.type,
  entity_type: event.type.split(".")[0] as RealtimeEventEnvelope["entity_type"],
  entity_id: event.entityId,
  actor: event.actorUserId
    ? { type: "human", id: event.actorUserId }
    : event.actorAgentId
      ? { type: "agent", id: event.actorAgentId }
      : null
});
const principalOf = (s: Setup, agent: { id: string }) => ({
  agentId: agent.id,
  projectId: s.project.id,
  credentialId: ""
});

withSetup(
  "classifies every kind for the waiting agent and skips the rest",
  async (s) => {
    const agentC = await s.createAgent("agent-c");
    const watched = await s.agentTask(s.agentA, "Watched");
    const muted = await s.agentTask(s.agentA, "Muted");
    await s.ok(
      s.asAgent(s.agentA, "POST", `/tasks/${muted.id}/watch`, {
        watching: false
      })
    );
    const unwatched = await s.humanTask("Unwatched");
    const claimed = await s.humanTask("Claimed by A");
    await s.claim(s.agentA, claimed.id);
    const moved = await s.agentTask(s.agentA, "Moved");
    const start = await s.cursorOf(s.agentA);

    const direct = await s.chat(s.agentB, [s.agentA]);
    const hello = await s.send(s.agentB, direct.id, "hello A");
    await s.send(s.agentA, direct.id, "hi B");
    const secret = await s.chat(s.agentB, [agentC]);
    await s.send(s.agentB, secret.id, "secret");
    const group = await s.chat(s.agentB, [s.agentA, agentC], "Team");
    await s.send(s.agentB, group.id, "no mention");
    const mentioned = await s.send(s.agentB, group.id, "@agent-a look", [
      s.agentA
    ]);
    await s.comment(s.agentB, watched.id, "watched comment");
    await s.comment(s.agentA, watched.id, "own note");
    await s.comment(s.agentB, unwatched.id, "not watched");
    await s.comment(s.agentB, unwatched.id, "@agent-a see", [
      { type: "agent", id: s.agentA.id }
    ]);
    await s.comment(s.agentB, muted.id, "muted comment");
    await s.comment(s.agentB, claimed.id, "on your claim");
    await s.endClaim(s.agentB, "release", await s.claim(s.agentB, watched.id));
    await s.ok(
      s.asHuman("alice", "POST", `/tasks/${moved.id}/move`, {
        status: "backlog",
        expected_version: moved.version
      })
    );
    // A handoff: the direct message plus the handoffs row and its event.
    const handoffMessage = await s.send(
      s.agentB,
      direct.id,
      "**Handoff** take Watched"
    );
    const [handoff] = await s.db
      .insert(handoffs)
      .values({
        projectId: s.project.id,
        chatId: direct.id,
        messageId: handoffMessage.id,
        messageSequence: handoffMessage.sequence,
        fromAgentId: s.agentB.id,
        toAgentId: s.agentA.id,
        taskId: watched.id,
        chainId: randomUUID(),
        hop: 0
      })
      .returning();
    await s.insertEvent({
      type: "chat.handoff_created",
      actorAgentId: s.agentB.id,
      entityId: direct.id,
      payload: {
        message_id: handoffMessage.id,
        handoff_id: handoff.id,
        participant: { type: "agent", id: s.agentA.id },
        task_id: watched.id,
        hop: 0
      }
    });
    await s.insertEvent({
      type: "task.status_changed",
      actorAgentId: s.agentB.id,
      entityId: watched.id,
      payload: {
        from_status: "in_progress",
        to_status: "blocked",
        claim_id: null
      }
    });
    const resolvedBlock = async (taskId: string, creator: Agent) => {
      const [block] = await s.db
        .insert(taskBlocks)
        .values({
          projectId: s.project.id,
          taskId,
          createdByType: "agent",
          createdByAgentId: creator.id,
          reason: "Waiting",
          resolvedAt: new Date(),
          resolution: "resolved_by_human",
          resolvedByUserId: s.alice.id
        })
        .returning();
      await s.insertEvent({
        type: "task.block_resolved",
        actorUserId: s.alice.id,
        entityId: taskId,
        payload: {
          block_id: block.id,
          resolution: "resolved_by_human",
          to_status: "in_progress"
        }
      });
    };
    await resolvedBlock(claimed.id, s.agentA);
    await resolvedBlock(unwatched.id, s.agentB);
    // A's own lapsed claim is skipped; another agent's is a release.
    await s.insertEvent({
      type: "claim.expired",
      entityId: randomUUID(),
      payload: {
        task_id: claimed.id,
        session_id: s.agentA.sessionId,
        agent_id: s.agentA.id
      }
    });
    await s.insertEvent({
      type: "claim.expired",
      entityId: randomUUID(),
      payload: {
        task_id: watched.id,
        session_id: agentC.sessionId,
        agent_id: agentC.id
      }
    });

    const all = await s.waitOk(s.agentA, { after: start, timeout_ms: 0 });
    assert.equal(all.status, "updates");
    assert.equal(all.cursor, await s.maxEventId());
    const agentB = { type: "agent", id: s.agentB.id, name: "agent-b" };
    assert.deepEqual(
      all.events.map((event) => [event.kind, event.task?.id ?? event.chat_id]),
      [
        ["direct_message", direct.id],
        ["mention", group.id],
        ["task_comment", watched.id],
        ["mention", unwatched.id],
        ["task_comment", claimed.id],
        ["claim_released", watched.id],
        ["status_changed", moved.id],
        ["handoff", watched.id],
        ["status_changed", watched.id],
        ["blocker_resolved", claimed.id],
        ["claim_released", watched.id]
      ]
    );
    const [
      dm,
      groupMention,
      watchedComment,
      ,
      ,
      released,
      move,
      handed,
      ,
      blocker,
      expired
    ] = all.events;
    assert.deepEqual(dm, {
      kind: "direct_message",
      event_id: dm.event_id,
      occurred_at: dm.occurred_at,
      actor: agentB,
      task: null,
      chat_id: direct.id,
      message_id: hello.id,
      excerpt: "hello A",
      branch_id: null
    });
    assert.equal(groupMention.message_id, mentioned.id);
    assert.deepEqual(watchedComment.task, {
      id: watched.id,
      key: watched.key,
      title: "Watched"
    });
    assert.equal(watchedComment.comment_sequence, 1);
    assert.equal(watchedComment.excerpt, "watched comment");
    assert.deepEqual(released.actor, agentB);
    assert.deepEqual(move.actor, {
      type: "human",
      id: s.alice.id,
      name: "alice"
    });
    assert.equal(move.from_status, "ready");
    assert.equal(move.to_status, "backlog");
    assert.equal(handed.handoff_id, handoff.id);
    assert.equal(handed.message_id, handoffMessage.id);
    assert.equal(handed.excerpt, "**Handoff** take Watched");
    assert.equal(blocker.to_status, "in_progress");
    assert.equal(expired.actor, null);
    assert.ok(all.attention.unread_chats.length > 0);

    const directed = await s.waitOk(s.agentA, {
      after: start,
      timeout_ms: 0,
      directed_only: true
    });
    assert.deepEqual(
      directed.events.map((event) => [
        event.kind,
        event.task?.id ?? event.chat_id
      ]),
      [
        ["direct_message", direct.id],
        ["mention", group.id],
        ["mention", unwatched.id],
        ["task_comment", claimed.id],
        ["handoff", watched.id],
        ["blocker_resolved", claimed.id]
      ]
    );
    const filtered = await s.waitOk(s.agentA, {
      after: start,
      timeout_ms: 0,
      kinds: "mention,handoff"
    });
    assert.deepEqual(
      filtered.events.map((event) => event.kind),
      ["mention", "mention", "handoff"]
    );
    // B never sees its own actions, and only the chats it belongs to.
    const forB = await s.waitOk(s.agentB, { after: start, timeout_ms: 0 });
    assert.ok(forB.events.length > 0);
    assert.ok(forB.events.every((event) => event.actor?.id !== s.agentB.id));
    assert.deepEqual(
      forB.events
        .filter((event) => event.kind === "direct_message")
        .map((event) => event.excerpt),
      ["hi B"]
    );
    const invalid = await s.wait(s.agentA, { after: "abc", timeout_ms: 0 });
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
);

withSetup("caps events per response and resumes from the cursor", async (s) => {
  const direct = await s.chat(s.agentB, [s.agentA]);
  const start = await s.cursorOf(s.agentA);
  const dmEvent = (sequence: number) => ({
    projectId: s.project.id,
    type: "chat.message_created",
    actorAgentId: s.agentB.id,
    entityId: direct.id,
    payload: { message_id: randomUUID(), sequence, mentions: [] }
  });
  await s.db
    .insert(projectEvents)
    .values(Array.from({ length: 55 }, (_, index) => dmEvent(index + 1)));
  const first = await s.waitOk(s.agentA, { after: start, timeout_ms: 0 });
  assert.equal(first.events.length, 50);
  assert.equal(first.cursor, String(first.events.at(-1)!.event_id));
  const rest = await s.waitOk(s.agentA, { after: first.cursor, timeout_ms: 0 });
  assert.equal(rest.events.length, 5);
  assert.equal(rest.cursor, await s.maxEventId());

  // A scan covers at most 500 events: a single poll stops there, while a
  // waiting call keeps scanning without sleeping.
  const quiet = rest.cursor;
  await s.db.insert(projectEvents).values(
    Array.from({ length: 600 }, () => ({
      projectId: s.project.id,
      type: "document.updated",
      actorAgentId: s.agentB.id,
      entityId: randomUUID(),
      payload: {}
    }))
  );
  await s.db.insert(projectEvents).values(dmEvent(56));
  const partial = await s.waitOk(s.agentA, { after: quiet, timeout_ms: 0 });
  assert.equal(partial.status, "timeout");
  assert.equal(Number(partial.cursor), Number(quiet) + 500);
  const started = Date.now();
  const scanned = await s.waitOk(s.agentA, {
    after: quiet,
    timeout_ms: 10_000
  });
  assert.equal(scanned.status, "updates");
  assert.equal(scanned.events.length, 1);
  assert.ok(Date.now() - started < 3_000);
});

withSetup(
  "a wait without a cursor returns pending only for directed items",
  async (s) => {
    const watched = await s.agentTask(s.agentA, "Watched");
    await s.comment(s.agentB, watched.id, "plain comment");
    // Unread watched-task comments are attention but never pending.
    let started = Date.now();
    const quiet = await s.waitOk(s.agentA, { timeout_ms: 300 });
    assert.equal(quiet.status, "timeout");
    assert.ok(Date.now() - started >= 250);
    assert.equal(quiet.cursor, await s.maxEventId());
    assert.equal(quiet.attention.tasks[0].task_id, watched.id);

    const direct = await s.chat(s.agentB, [s.agentA]);
    const message = await s.send(s.agentB, direct.id, "are you there?");
    started = Date.now();
    const pending = await s.waitOk(s.agentA, {});
    assert.ok(Date.now() - started < 3_000);
    assert.equal(pending.status, "pending");
    assert.deepEqual(pending.events, []);
    assert.equal(pending.cursor, await s.maxEventId());
    assert.deepEqual(pending.attention.unread_chats, [
      { chat_id: direct.id, unread_count: 1, mention_count: 0 }
    ]);
    // The cursor is level-triggered: resuming from it reports nothing new.
    const resumed = await s.waitOk(s.agentA, {
      after: pending.cursor,
      timeout_ms: 0
    });
    assert.equal(resumed.status, "timeout");
    assert.deepEqual(resumed.events, []);

    await s.ok(
      s.asAgent(s.agentA, "POST", `/chats/${direct.id}/read`, {
        through_message_id: message.id
      })
    );
    assert.equal(
      (await s.waitOk(s.agentA, { timeout_ms: 0 })).status,
      "timeout"
    );
    // Unread comments on a claimed task are directed.
    const claimed = await s.humanTask("Claimed");
    await s.claim(s.agentA, claimed.id);
    await s.comment(s.agentB, claimed.id, "please check");
    assert.equal(
      (await s.waitOk(s.agentA, { timeout_ms: 0 })).status,
      "pending"
    );
  }
);

withSetup("times out with the cursor and a fresh summary", async (s) => {
  const cursor = await s.cursorOf(s.agentA);
  const started = Date.now();
  const response = await s.waitOk(s.agentA, { after: cursor, timeout_ms: 300 });
  const elapsed = Date.now() - started;
  assert.equal(response.status, "timeout");
  assert.deepEqual(response.events, []);
  assert.equal(response.cursor, cursor);
  assert.equal(response.attention.cursor, cursor);
  assert.ok(elapsed >= 280 && elapsed < 3_000, `${elapsed}`);
  // timeout_ms=0 classifies once and returns.
  const polled = Date.now();
  const once = await s.waitOk(s.agentA, { after: cursor, timeout_ms: 0 });
  assert.equal(once.status, "timeout");
  assert.ok(Date.now() - polled < 1_000);
});

withSetup(
  "a handoff's direct message is held until its handoff row lands",
  async (s) => {
    const direct = await s.chat(s.agentB, [s.agentA]);
    const cursor = await s.cursorOf(s.agentA);
    // The handoff service sends the DM first and records the handoff in a
    // second transaction; a wait in between must not report the DM.
    const message = await s.send(s.agentB, direct.id, "**Handoff**\n\ntake it");
    const early = await s.waitOk(s.agentA, { after: cursor, timeout_ms: 0 });
    assert.deepEqual(early.events, []);
    assert.equal(early.cursor, cursor);
    const [handoff] = await s.db
      .insert(handoffs)
      .values({
        projectId: s.project.id,
        chatId: direct.id,
        messageId: message.id,
        messageSequence: message.sequence,
        fromAgentId: s.agentB.id,
        toAgentId: s.agentA.id,
        chainId: randomUUID(),
        hop: 0
      })
      .returning();
    await s.insertEvent({
      type: "chat.handoff_created",
      actorAgentId: s.agentB.id,
      entityId: direct.id,
      payload: {
        message_id: message.id,
        handoff_id: handoff.id,
        participant: { type: "agent", id: s.agentA.id },
        task_id: null,
        hop: 0
      }
    });
    const late = await s.waitOk(s.agentA, { after: early.cursor, timeout_ms: 0 });
    assert.deepEqual(
      late.events.map((event) => event.kind),
      ["handoff"]
    );
    // An ordinary DM is never held.
    const next = await s.send(s.agentB, direct.id, "plain hello");
    const plain = await s.waitOk(s.agentA, { after: late.cursor, timeout_ms: 0 });
    assert.deepEqual(
      plain.events.map((event) => [event.kind, event.message_id]),
      [["direct_message", next.id]]
    );
  }
);

withSetup("committed events wake a waiting agent", async (s) => {
  const watched = await s.agentTask(s.agentA, "Watched");
  const moved = await s.agentTask(s.agentA, "Moved");
  const direct = await s.chat(s.agentB, [s.agentA]);
  const group = await s.chat(s.agentB, [s.agentA], "Pair");
  const token = await s.claim(s.agentB, watched.id);
  const expectWake = async (kind: string, trigger: () => Promise<unknown>) => {
    const cursor = await s.cursorOf(s.agentA);
    const started = Date.now();
    const pending = s.wait(s.agentA, { after: cursor, timeout_ms: 10_000 });
    await delay(150);
    await trigger();
    const response = waitResponseSchema.parse(await s.ok(pending));
    // Woken by notify, well before the 5 s fallback re-check.
    assert.ok(
      Date.now() - started < 3_000,
      `${kind} took ${Date.now() - started} ms`
    );
    assert.equal(response.status, "updates");
    assert.deepEqual(
      response.events.map((event) => event.kind),
      [kind]
    );
  };
  await expectWake("direct_message", () => s.send(s.agentB, direct.id, "ping"));
  await expectWake("mention", () =>
    s.send(s.agentB, group.id, "@agent-a", [s.agentA])
  );
  await expectWake("task_comment", () =>
    s.comment(s.agentB, watched.id, "update")
  );
  await expectWake("claim_released", () =>
    s.endClaim(s.agentB, "release", token)
  );
  await expectWake("status_changed", () =>
    s.ok(
      s.asHuman("alice", "POST", `/tasks/${moved.id}/move`, {
        status: "backlog",
        expected_version: moved.version
      })
    )
  );

  // Handoff, status and block events come from other services; publish them
  // to a hub directly.
  const hub = directHub(s);
  const principal = principalOf(s, s.agentA);
  const [block] = await s.db
    .insert(taskBlocks)
    .values({
      projectId: s.project.id,
      taskId: moved.id,
      createdByType: "agent",
      createdByAgentId: s.agentA.id,
      reason: "Waiting on B",
      resolvedAt: new Date(),
      resolution: "participant_responded"
    })
    .returning();
  const hubWake = async (
    kind: string,
    event: Parameters<Setup["insertEvent"]>[0]
  ) => {
    const cursor = await s.cursorOf(s.agentA);
    const started = Date.now();
    const pending = hub.wait(
      principal,
      waitQuerySchema.parse({ after: cursor, timeout_ms: 10_000 }),
      new AbortController().signal
    );
    await delay(100);
    hub.notify(envelope(await s.insertEvent(event)));
    const response = await pending;
    assert.ok(
      Date.now() - started < 3_000,
      `${kind} took ${Date.now() - started} ms`
    );
    assert.deepEqual(
      response.events.map((value) => value.kind),
      [kind]
    );
  };
  await hubWake("handoff", {
    type: "chat.handoff_created",
    actorAgentId: s.agentB.id,
    entityId: direct.id,
    payload: {
      message_id: randomUUID(),
      handoff_id: randomUUID(),
      participant: { type: "agent", id: s.agentA.id },
      task_id: null,
      hop: 0
    }
  });
  await hubWake("status_changed", {
    type: "task.status_changed",
    actorAgentId: s.agentB.id,
    entityId: watched.id,
    payload: { task_id: watched.id, from_status: "ready", to_status: "blocked" }
  });
  await hubWake("blocker_resolved", {
    type: "task.block_resolved",
    actorAgentId: s.agentB.id,
    entityId: moved.id,
    payload: {
      block_id: block.id,
      resolution: "participant_responded",
      to_status: "ready"
    }
  });

  // Own events, other projects and unrelated types never wake a waiter.
  const cursor = await s.cursorOf(s.agentA);
  const started = Date.now();
  const pending = hub.wait(
    principal,
    waitQuerySchema.parse({ after: cursor, timeout_ms: 700 }),
    new AbortController().signal
  );
  await delay(100);
  const own = await s.insertEvent({
    type: "task.comment_created",
    actorAgentId: s.agentA.id,
    entityId: randomUUID(),
    payload: { task_id: watched.id, sequence: 99, mentions: [] }
  });
  hub.notify(envelope(own));
  hub.notify({ ...envelope(own), project_id: s.otherProject.id, actor: null });
  hub.notify({
    ...envelope(own),
    event_type: "document.updated",
    entity_type: "document",
    actor: null
  });
  const quiet = await pending;
  assert.equal(quiet.status, "timeout");
  assert.equal(quiet.cursor, String(own.id));
  assert.ok(Date.now() - started >= 650);
});

withSetup(
  "concurrent waits are limited per agent and per project",
  async (s) => {
    const cursor = await s.cursorOf(s.agentA);
    const waits = [1, 2, 3].map(() =>
      s.wait(s.agentA, { after: cursor, timeout_ms: 10_000 })
    );
    let refused;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      refused = await s.wait(s.agentA, { after: cursor, timeout_ms: 0 });
      if (refused.statusCode === 429) break;
      await delay(100);
    }
    assert.equal(refused!.statusCode, 429, refused!.body);
    assert.equal(refused!.json().error.code, "WAIT_LIMIT");
    // Other agents keep their own budget.
    assert.equal(
      (await s.waitOk(s.agentB, { after: cursor, timeout_ms: 0 })).status,
      "timeout"
    );
    const direct = await s.chat(s.agentB, [s.agentA]);
    await s.send(s.agentB, direct.id, "wake up");
    for (const response of await Promise.all(waits)) {
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().status, "updates");
    }
    assert.equal(
      (await s.wait(s.agentA, { after: cursor, timeout_ms: 0 })).statusCode,
      200
    );

    const hub = directHub(s);
    const controller = new AbortController();
    const query = waitQuerySchema.parse({ after: cursor, timeout_ms: 10_000 });
    const principals = Array.from({ length: waitLimitPerProject }, () =>
      principalOf(s, { id: randomUUID() })
    );
    const active = principals.map((principal) =>
      hub.wait(principal, query, controller.signal)
    );
    await assert.rejects(
      hub.wait(principalOf(s, { id: randomUUID() }), query, controller.signal),
      (error: { statusCode?: number; code?: string }) =>
        error.statusCode === 429 && error.code === "WAIT_LIMIT"
    );
    assert.equal(hub.waitingSince(s.project.id).size, waitLimitPerProject);
    controller.abort();
    for (const response of await Promise.all(active))
      assert.equal(response.status, "timeout");
    assert.equal(hub.waitingSince(s.project.id).size, 0);
  }
);

withSetup("a client disconnect ends the wait and frees its slot", async (s) => {
  const address = await s.app.listen({ port: 0, host: "127.0.0.1" });
  const cursor = await s.cursorOf(s.agentA);
  const agentsView = async () =>
    agentAttentionResponseSchema
      .parse(
        await s.ok(
          s.asHuman(
            "alice",
            "GET",
            `/projects/${s.project.id}/attention/agents`
          )
        )
      )
      .agents.find((agent) => agent.agent_id === s.agentA.id)!;
  const controller = new AbortController();
  const request = fetch(
    `${address}/api/v1/agent/attention/wait?after=${cursor}&timeout_ms=20000`,
    {
      headers: { authorization: `Bearer ${s.agentA.token}` },
      signal: controller.signal
    }
  ).catch((error: unknown) => error);
  let view = await agentsView();
  for (
    let attempt = 0;
    attempt < 30 && view.waiting_since === null;
    attempt += 1
  ) {
    await delay(100);
    view = await agentsView();
  }
  assert.notEqual(view.waiting_since, null);
  controller.abort();
  assert.ok((await request) instanceof Error);
  for (
    let attempt = 0;
    attempt < 30 && view.waiting_since !== null;
    attempt += 1
  ) {
    await delay(100);
    view = await agentsView();
  }
  assert.equal(view.waiting_since, null);
});

test("closing the server ends active waits", async () => {
  const s = await setup();
  const cursor = await s.cursorOf(s.agentA);
  const started = Date.now();
  const pending = s.wait(s.agentA, { after: cursor, timeout_ms: 20_000 });
  await delay(200);
  await s.app.close();
  const response = await pending;
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().status, "timeout");
  assert.ok(Date.now() - started < 5_000);
});

withSetup(
  "agent attention reports waits, pending items, blocks and current work",
  async (s) => {
    const task = await s.humanTask("Current");
    await s.claim(s.agentA, task.id);
    await s.db.insert(taskBlocks).values({
      projectId: s.project.id,
      taskId: task.id,
      createdByType: "agent",
      createdByAgentId: s.agentA.id,
      reason: "Need the schema from B"
    });
    const direct = await s.chat(s.agentB, [s.agentA]);
    await s.send(s.agentB, direct.id, "one");
    await s.send(s.agentB, direct.id, "two");
    await s.comment(s.agentB, task.id, "@agent-a heads up", [
      { type: "agent", id: s.agentA.id }
    ]);
    const cursor = await s.cursorOf(s.agentB);
    const waiting = s.wait(s.agentB, { after: cursor, timeout_ms: 1_500 });
    await delay(200);
    const response = await s.ok(
      s.asHuman("bob", "GET", `/projects/${s.project.id}/attention/agents`)
    );
    const { agents } = agentAttentionResponseSchema.parse(response);
    assert.deepEqual(
      agents.map((agent) => agent.agent_id),
      [s.agentA.id, s.agentB.id]
    );
    const [a, b] = agents;
    assert.equal(a.waiting_since, null);
    // Two direct messages plus a mention on the claimed task.
    assert.equal(a.pending_directed_count, 3);
    assert.deepEqual(a.open_block, {
      task: { id: task.id, key: task.key, title: "Current" },
      reason: "Need the schema from B"
    });
    assert.deepEqual(a.current_task, {
      id: task.id,
      key: task.key,
      title: "Current",
      status: "claimed"
    });
    assert.ok(
      b.waiting_since !== null && Date.parse(b.waiting_since) <= Date.now()
    );
    assert.equal(b.pending_directed_count, 0);
    assert.equal(b.open_block, null);
    assert.equal(b.current_task, null);
    assert.equal((await waiting).json().status, "timeout");
    const after = await s.ok(
      s.asHuman("bob", "GET", `/projects/${s.project.id}/attention/agents`)
    );
    assert.equal(after.agents[1].waiting_since, null);
    assert.equal(
      (
        await s.asHuman(
          "bob",
          "GET",
          `/projects/${s.otherProject.id}/attention/agents`
        )
      ).statusCode,
      403
    );
  }
);
