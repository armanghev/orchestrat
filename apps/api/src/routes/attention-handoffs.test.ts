import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  chatMessages,
  chats,
  handoffs,
  organizationMembers,
  projectEvents,
  taskBlocks,
  taskWatches,
  tasks,
  users
} from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
import { ChatService } from "../services/chat-service.js";
import { fixture } from "../test/fixture.js";

type Setup = Awaited<ReturnType<typeof setup>>;
type Agent = { id: string; token: string; sessionId: string };
let keys = 0;
const nextKey = () => `handoff-test-${++keys}`;
const human = (name: "alice" | "bob") => ({ authorization: `Bearer ${name}` });

async function setup() {
  const { app, db } = await fixture();
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: human("alice"),
      payload: { name: "Handoffs" }
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
    ).json() as { id: string };
  const project = await createProject("Handoff project");
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

  const createAgent = async (
    name: string,
    projectId = project.id
  ): Promise<Agent> => {
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
  const agentC = await createAgent("agent-c");

  const asAgent = (
    agent: { token: string },
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
    key: string | null = nextKey()
  ) =>
    app.inject({
      method,
      url: `/api/v1/agent${url}`,
      headers: {
        authorization: `Bearer ${agent.token}`,
        ...(key === null ? {} : { "idempotency-key": key })
      },
      ...(payload === undefined ? {} : { payload: payload as object })
    });
  const asHuman = (
    name: "alice" | "bob",
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
    key: string | null = nextKey()
  ) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        ...human(name),
        ...(key === null ? {} : { "idempotency-key": key })
      },
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
    return response.json() as { id: string; key: string; title: string };
  };
  const to = (agent: { id: string }) => ({
    type: "agent" as const,
    id: agent.id
  });
  const handoff = async (
    from: { token: string },
    recipient: { type: "human" | "agent"; id: string },
    body = "Please take this.",
    taskId?: string,
    key = nextKey()
  ) =>
    asAgent(
      from,
      "POST",
      "/handoffs",
      {
        to: recipient,
        body_markdown: body,
        ...(taskId ? { task_id: taskId } : {})
      },
      key
    );
  const handoffOk = async (
    from: { token: string },
    recipient: { type: "human" | "agent"; id: string },
    taskId?: string
  ) => {
    const response = await handoff(from, recipient, "Over to you.", taskId);
    assert.equal(response.statusCode, 201, response.body);
    return response.json().handoff as {
      id: string;
      chat_id: string;
      message_id: string;
      message_sequence: number;
      chain_id: string;
      hop: number;
    };
  };
  const summary = async (agent: { token: string }) => {
    const response = await asAgent(agent, "GET", "/attention");
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const messagesIn = async (chatId: string) =>
    db.select().from(chatMessages).where(eq(chatMessages.chatId, chatId));
  // Seeds handoff rows (and their messages) straight into the database for
  // the hourly limits, reusing an existing chat.
  const seedHandoffs = async (
    chatId: string,
    count: number,
    from: { agentId: string },
    recipient: { agentId: string }
  ) => {
    const offset = 10_000 + (await messagesIn(chatId)).length * 1000;
    const [{ branchId }] = await db
      .select({ branchId: chats.branchId })
      .from(chats)
      .where(eq(chats.id, chatId));
    const messages = await db
      .insert(chatMessages)
      .values(
        Array.from({ length: count }, (_, index) => ({
          projectId: project.id,
          branchId,
          chatId,
          sequence: offset + index,
          authorType: "agent" as const,
          authorAgentId: from.agentId,
          authorName: "seed",
          bodyMarkdown: "seeded"
        }))
      )
      .returning();
    await db.insert(handoffs).values(
      messages.map((message) => ({
        projectId: project.id,
        chatId,
        messageId: message.id,
        messageSequence: message.sequence,
        fromAgentId: from.agentId,
        toAgentId: recipient.agentId,
        chainId: randomUUID(),
        hop: 0
      }))
    );
  };
  return {
    app,
    db,
    project,
    otherProject,
    alice,
    bob,
    agentA,
    agentB,
    agentC,
    createAgent,
    asAgent,
    asHuman,
    createTask,
    to,
    handoff,
    handoffOk,
    summary,
    messagesIn,
    seedHandoffs
  };
}

const withSetup = (name: string, body: (s: Setup) => Promise<void>) =>
  test(name, async (t) => {
    const s = await setup();
    t.after(() => s.app.close());
    await body(s);
  });

withSetup(
  "a handoff reuses the direct chat and stays pending until acknowledged",
  async (s) => {
    const task = await s.createTask("Ship the parser");
    const direct = await s.asAgent(s.agentA, "POST", "/chats", {
      kind: "direct",
      participants: [s.to(s.agentB)]
    });
    assert.equal(direct.statusCode, 201, direct.body);
    const chatId = direct.json().id as string;

    const withTask = await s.handoff(
      s.agentA,
      s.to(s.agentB),
      "Parser is yours.",
      task.id
    );
    assert.equal(withTask.statusCode, 201, withTask.body);
    const first = withTask.json().handoff;
    assert.equal(first.chat_id, chatId);
    assert.deepEqual(first.from, {
      type: "agent",
      id: s.agentA.id,
      name: "agent-a"
    });
    assert.deepEqual(first.to, {
      type: "agent",
      id: s.agentB.id,
      name: "agent-b"
    });
    assert.deepEqual(first.task, {
      id: task.id,
      key: task.key,
      title: "Ship the parser"
    });
    assert.equal(first.hop, 0);
    assert.equal(first.chain_id, first.id);
    const plain = await s.handoffOk(s.agentA, s.to(s.agentB));
    assert.equal(plain.chat_id, chatId);

    const messages = await s.messagesIn(chatId);
    const bodyOf = (id: string) =>
      messages.find((message) => message.id === id)!.bodyMarkdown;
    assert.equal(
      bodyOf(first.message_id),
      `**Handoff** · ${task.key} Ship the parser\n\nParser is yours.`
    );
    assert.equal(bodyOf(plain.message_id), "**Handoff**\n\nOver to you.");

    // The recipient watches the task from the current comment position.
    const [watch] = await s.db
      .select()
      .from(taskWatches)
      .where(
        and(
          eq(taskWatches.taskId, task.id),
          eq(taskWatches.agentId, s.agentB.id)
        )
      );
    assert.equal(watch.reason, "handoff");
    assert.equal(watch.state, "watching");

    // Pending for the recipient only, derived from the chat read position.
    assert.deepEqual((await s.summary(s.agentA)).handoffs, []);
    let pending = (await s.summary(s.agentB)).handoffs;
    assert.deepEqual(
      pending.map((item: any) => [item.handoff_id, item.task?.key ?? null]),
      [
        [plain.id, null],
        [first.id, task.key]
      ]
    );
    const acknowledged = await s.asAgent(
      s.agentB,
      "POST",
      "/attention/acknowledge",
      {
        items: [{ type: "handoff", handoff_id: first.id }]
      }
    );
    assert.equal(acknowledged.statusCode, 200, acknowledged.body);
    pending = (await s.summary(s.agentB)).handoffs;
    assert.deepEqual(
      pending.map((item: any) => item.handoff_id),
      [plain.id]
    );
    const chat = await s.asAgent(s.agentB, "GET", `/chats/${chatId}`);
    assert.equal(chat.json().last_read_sequence, first.message_sequence);
  }
);

withSetup(
  "retries with the same key return the same handoff and send one message",
  async (s) => {
    const key = "retry-me";
    const first = await s.handoff(
      s.agentA,
      s.to(s.agentB),
      "Take it.",
      undefined,
      key
    );
    const again = await s.handoff(
      s.agentA,
      s.to(s.agentB),
      "Take it.",
      undefined,
      key
    );
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(again.statusCode, 201, again.body);
    assert.deepEqual(again.json(), first.json());
    const { handoff } = first.json();
    assert.equal((await s.messagesIn(handoff.chat_id)).length, 1);
    assert.equal((await s.db.select().from(handoffs)).length, 1);
    const created = await s.db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.type, "chat.handoff_created"));
    assert.equal(created.length, 1);
    assert.equal(created[0].entityId, handoff.chat_id);
    assert.deepEqual(created[0].payload, {
      message_id: handoff.message_id,
      handoff_id: handoff.id,
      participant: { type: "agent", id: s.agentB.id },
      task_id: null,
      hop: 0
    });

    // Reusing the key for a different request conflicts instead of sending.
    const conflict = await s.handoff(
      s.agentA,
      s.to(s.agentB),
      "Something else.",
      undefined,
      key
    );
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");

    // If the second transaction never committed, a retry finds the sent
    // message and completes the handoff without a second message.
    await s.db.delete(handoffs).where(eq(handoffs.id, handoff.id));
    const completed = await s.handoff(
      s.agentA,
      s.to(s.agentB),
      "Take it.",
      undefined,
      key
    );
    assert.equal(completed.statusCode, 201, completed.body);
    assert.equal(completed.json().handoff.message_id, handoff.message_id);
    assert.notEqual(completed.json().handoff.id, handoff.id);
    assert.equal((await s.messagesIn(handoff.chat_id)).length, 1);

    const missingKey = await s.asAgent(
      s.agentA,
      "POST",
      "/handoffs",
      { to: s.to(s.agentB), body_markdown: "No key" },
      null
    );
    assert.equal(missingKey.statusCode, 400, missingKey.body);
    assert.match(missingKey.json().error.message, /Idempotency-Key/);
  }
);

withSetup("handoffs validate the recipient and task", async (s) => {
  const self = await s.handoff(s.agentA, s.to(s.agentA));
  assert.equal(self.statusCode, 400, self.body);
  const outsider = await s.createAgent("outsider", s.otherProject.id);
  const foreign = await s.handoff(s.agentA, s.to(outsider));
  assert.equal(foreign.statusCode, 400, foreign.body);
  const revoked = await s.createAgent("revoked");
  const revoke = await s.asHuman(
    "alice",
    "POST",
    `/projects/${s.project.id}/agents/${revoked.id}/revoke`
  );
  assert.ok([200, 204].includes(revoke.statusCode), revoke.body);
  assert.equal((await s.handoff(s.agentA, s.to(revoked))).statusCode, 400);
  const otherTask = await s.createTask("Elsewhere", s.otherProject.id);
  const wrongTask = await s.handoff(
    s.agentA,
    s.to(s.agentB),
    "Look",
    otherTask.id
  );
  assert.equal(wrongTask.statusCode, 404, wrongTask.body);
  const tooLong = await s.handoff(s.agentA, s.to(s.agentB), "x".repeat(4001));
  assert.equal(tooLong.statusCode, 400, tooLong.body);
  assert.equal((await s.db.select().from(handoffs)).length, 0);
  assert.equal((await s.db.select().from(chatMessages)).length, 0);
});

withSetup(
  "a human hands off from the dashboard and the agent sees it",
  async (s) => {
    const task = await s.createTask("Review the docs");
    const response = await s.asHuman(
      "alice",
      "POST",
      `/projects/${s.project.id}/handoffs`,
      {
        to: s.to(s.agentA),
        body_markdown: "Can you check these?",
        task_id: task.id
      }
    );
    assert.equal(response.statusCode, 201, response.body);
    const handoff = response.json().handoff;
    assert.deepEqual(handoff.from, {
      type: "human",
      id: s.alice.id,
      name: "alice"
    });
    assert.equal(handoff.hop, 0);
    const pending = (await s.summary(s.agentA)).handoffs;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].from.type, "human");
    assert.equal(pending[0].task.key, task.key);
    const noKey = await s.asHuman(
      "alice",
      "POST",
      `/projects/${s.project.id}/handoffs`,
      { to: s.to(s.agentA), body_markdown: "Again" },
      null
    );
    assert.equal(noKey.statusCode, 400, noKey.body);
    // Agents can hand off to humans too.
    const toHuman = await s.handoffOk(
      s.agentA,
      { type: "human", id: s.bob.id },
      task.id
    );
    const [watch] = await s.db
      .select()
      .from(taskWatches)
      .where(
        and(eq(taskWatches.taskId, task.id), eq(taskWatches.userId, s.bob.id))
      );
    assert.equal(watch.reason, "handoff");
    const bobSummary = await s.asHuman(
      "bob",
      "GET",
      `/projects/${s.project.id}/attention`
    );
    assert.deepEqual(
      bobSummary.json().handoffs.map((item: any) => item.handoff_id),
      [toHuman.id]
    );
  }
);

withSetup(
  "chains are inherited from the latest incoming handoff and reset by a human",
  async (s) => {
    const one = await s.handoffOk(s.agentA, s.to(s.agentB));
    const two = await s.handoffOk(s.agentB, s.to(s.agentA));
    const three = await s.handoffOk(s.agentA, s.to(s.agentB));
    assert.deepEqual([one.hop, two.hop, three.hop], [0, 1, 2]);
    assert.equal(two.chain_id, one.chain_id);
    assert.equal(three.chain_id, one.chain_id);

    // A human message to B after its latest incoming handoff breaks the chain.
    await delay(5);
    const direct = await s.asHuman(
      "alice",
      "POST",
      `/projects/${s.project.id}/chats`,
      {
        kind: "direct",
        participants: [s.to(s.agentB)]
      }
    );
    const sent = await s.asHuman(
      "alice",
      "POST",
      `/chats/${direct.json().id}/messages`,
      {
        body_markdown: "Stop and check with me."
      }
    );
    assert.equal(sent.statusCode, 201, sent.body);
    const fresh = await s.handoffOk(s.agentB, s.to(s.agentC));
    assert.equal(fresh.hop, 0);
    assert.equal(fresh.chain_id, fresh.id);
    // C continues the fresh chain.
    const next = await s.handoffOk(s.agentC, s.to(s.agentA));
    assert.deepEqual([next.chain_id, next.hop], [fresh.chain_id, 1]);

    // A human-sent handoff always starts a new chain.
    const fromHuman = await s.asHuman(
      "alice",
      "POST",
      `/projects/${s.project.id}/handoffs`,
      {
        to: s.to(s.agentC),
        body_markdown: "New work"
      }
    );
    assert.equal(fromHuman.json().handoff.hop, 0);
    assert.equal(
      fromHuman.json().handoff.chain_id,
      fromHuman.json().handoff.id
    );

    // A human mention in a task comment also resets. A's latest incoming
    // handoff is C's hop 1, so the loop continues from there first.
    const task = await s.createTask("Mention reset");
    const loop = await s.handoffOk(s.agentA, s.to(s.agentB));
    assert.deepEqual([loop.chain_id, loop.hop], [fresh.chain_id, 2]);
    const back = await s.handoffOk(s.agentB, s.to(s.agentA));
    assert.equal(back.hop, 3);
    await delay(5);
    const comment = await s.asHuman(
      "alice",
      "POST",
      `/tasks/${task.id}/comments`,
      {
        body_markdown: "Agent A, pause here.",
        mentions: [s.to(s.agentA)]
      }
    );
    assert.equal(comment.statusCode, 201, comment.body);
    const afterMention = await s.handoffOk(s.agentA, s.to(s.agentC));
    assert.equal(afterMention.hop, 0);
  }
);

withSetup(
  "a ping-pong chain stops past hop 4 before sending the message",
  async (s) => {
    const hops: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const [from, recipient] =
        index % 2 === 0 ? [s.agentA, s.agentB] : [s.agentB, s.agentA];
      hops.push((await s.handoffOk(from, s.to(recipient))).hop);
    }
    assert.deepEqual(hops, [0, 1, 2, 3, 4]);
    const [existing] = await s.db.select().from(handoffs).limit(1);
    const before = (await s.messagesIn(existing.chatId)).length;
    const refused = await s.handoff(s.agentB, s.to(s.agentA));
    assert.equal(refused.statusCode, 429, refused.body);
    assert.equal(refused.json().error.code, "HANDOFF_CHAIN_LIMIT");
    assert.match(refused.json().error.message, /ask a human/i);
    assert.equal((await s.messagesIn(existing.chatId)).length, before);
  }
);

withSetup(
  "pair, sender and project hourly limits refuse before sending",
  async (s) => {
    const agentD = await s.createAgent("agent-d");
    // Pair: six A→C handoffs per hour; each starts its own chain.
    for (let index = 0; index < 6; index += 1)
      await s.handoffOk(s.agentA, s.to(s.agentC));
    const [pairChat] = await s.db.select().from(handoffs).limit(1);
    const pair = await s.handoff(s.agentA, s.to(s.agentC));
    assert.equal(pair.statusCode, 429, pair.body);
    assert.equal(pair.json().error.code, "HANDOFF_RATE_LIMITED");
    assert.equal(pair.json().error.details.scope, "pair");
    assert.match(pair.json().error.message, /ask a human/i);
    assert.equal((await s.messagesIn(pairChat.chatId)).length, 6);
    // Another recipient still works.
    await s.handoffOk(s.agentA, s.to(agentD));

    // Sender: 20 per hour across recipients (13 more seeded A→D rows).
    await s.seedHandoffs(
      pairChat.chatId,
      13,
      { agentId: s.agentA.id },
      { agentId: agentD.id }
    );
    const sentByA = async () =>
      (
        await s.db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.authorAgentId, s.agentA.id))
      ).length;
    const beforeSender = await sentByA();
    const sender = await s.handoff(s.agentA, s.to(s.agentB));
    assert.equal(sender.statusCode, 429, sender.body);
    assert.equal(sender.json().error.details.scope, "sender");
    assert.equal(await sentByA(), beforeSender);

    // Project: 200 per hour across all senders.
    await s.seedHandoffs(
      pairChat.chatId,
      180,
      { agentId: s.agentC.id },
      { agentId: agentD.id }
    );
    const project = await s.handoff(s.agentB, s.to(agentD));
    assert.equal(project.statusCode, 429, project.body);
    assert.equal(project.json().error.details.scope, "project");

    // Humans are held to the same hourly counts.
    const fromHuman = await s.asHuman(
      "alice",
      "POST",
      `/projects/${s.project.id}/handoffs`,
      {
        to: s.to(s.agentB),
        body_markdown: "Busy project"
      }
    );
    assert.equal(fromHuman.statusCode, 429, fromHuman.body);
  }
);

withSetup("handoff events stay private to chat participants", async (s) => {
  const fromAlice = await s.asHuman(
    "alice",
    "POST",
    `/projects/${s.project.id}/handoffs`,
    {
      to: s.to(s.agentA),
      body_markdown: "Private ping"
    }
  );
  assert.equal(fromAlice.statusCode, 201, fromAlice.body);
  const handoff = fromAlice.json().handoff;
  const types = async (response: { json(): any }) =>
    response
      .json()
      .events.filter((event: any) => event.type === "chat.handoff_created")
      .map((event: any) => event.payload.handoff_id);
  assert.deepEqual(
    await types(
      await s.asHuman(
        "alice",
        "GET",
        `/projects/${s.project.id}/events?limit=100`
      )
    ),
    [handoff.id]
  );
  assert.deepEqual(
    await types(
      await s.asHuman(
        "bob",
        "GET",
        `/projects/${s.project.id}/events?limit=100`
      )
    ),
    []
  );
  assert.deepEqual(
    await types(await s.asAgent(s.agentA, "GET", "/events?limit=100")),
    [handoff.id]
  );
  assert.deepEqual(
    await types(await s.asAgent(s.agentB, "GET", "/events?limit=100")),
    []
  );
  // Realtime authorizes chat-entity events with the same chat check.
  const chats = new ChatService(s.db);
  assert.equal(await chats.canHumanViewChat(s.alice.id, handoff.chat_id), true);
  assert.equal(await chats.canHumanViewChat(s.bob.id, handoff.chat_id), false);
  // An agent-to-agent handoff is hidden from other agents.
  const between = await s.handoffOk(s.agentB, s.to(s.agentC));
  assert.deepEqual(
    await types(await s.asAgent(s.agentA, "GET", "/events?limit=100")),
    [handoff.id]
  );
  assert.deepEqual(
    await types(await s.asAgent(s.agentC, "GET", "/events?limit=100")),
    [between.id]
  );
});

withSetup(
  "a handoff from the blocked_on participant resolves the block",
  async (s) => {
    const task = await s.createTask("Blocked work");
    const claimed = await s.asAgent(
      s.agentA,
      "POST",
      `/tasks/${task.id}/claim`,
      {
        session_id: s.agentA.sessionId,
        lease_seconds: 300
      }
    );
    assert.equal(claimed.statusCode, 200, claimed.body);
    await s.db
      .update(tasks)
      .set({ status: "blocked" })
      .where(eq(tasks.id, task.id));
    const [block] = await s.db
      .insert(taskBlocks)
      .values({
        projectId: s.project.id,
        taskId: task.id,
        createdByType: "agent",
        createdByAgentId: s.agentA.id,
        reason: "Waiting on B's schema",
        blockedOnAgentId: s.agentB.id
      })
      .returning();
    const blockRow = async () =>
      (
        await s.db.select().from(taskBlocks).where(eq(taskBlocks.id, block.id))
      )[0];

    // Someone else, or B handing off to a third agent, does not resolve it.
    await s.handoffOk(s.agentC, s.to(s.agentA), task.id);
    await s.handoffOk(s.agentB, s.to(s.agentC), task.id);
    assert.equal((await blockRow()).resolvedAt, null);

    await s.handoffOk(s.agentB, s.to(s.agentA), task.id);
    const resolved = await blockRow();
    assert.equal(resolved.resolution, "participant_responded");
    assert.equal(resolved.resolvedByAgentId, s.agentB.id);
    const [row] = await s.db.select().from(tasks).where(eq(tasks.id, task.id));
    assert.equal(row.status, "in_progress");
  }
);

withSetup("wakes are budgeted per agent and once per chain", async (s) => {
  const first = await s.handoffOk(s.agentA, s.to(s.agentB));
  const wake = (agent: { token: string }, handoffId: string | null) =>
    s.asAgent(agent, "POST", "/wakes", {
      integration: "codex",
      handoff_id: handoffId
    });
  const woken = await wake(s.agentB, first.id);
  assert.equal(woken.statusCode, 201, woken.body);
  const [event] = await s.db
    .select()
    .from(projectEvents)
    .where(eq(projectEvents.id, woken.json().wake_event_id));
  assert.equal(event.type, "run.woken");
  assert.equal(event.entityId, s.agentB.id);
  assert.deepEqual(event.payload, {
    integration: "codex",
    handoff_id: first.id,
    hop: 0
  });

  // A second wake for the same handoff, or a later hop of its chain, is refused.
  const again = await wake(s.agentB, first.id);
  assert.equal(again.statusCode, 429, again.body);
  assert.equal(again.json().error.code, "WAKE_LIMIT");
  await s.handoffOk(s.agentB, s.to(s.agentA));
  const hop2 = await s.handoffOk(s.agentA, s.to(s.agentB));
  assert.equal(hop2.chain_id, first.chain_id);
  assert.equal((await wake(s.agentB, hop2.id)).statusCode, 429);
  // A new chain wakes again; someone else's handoff is not found.
  const fresh = await s.handoffOk(s.agentC, s.to(s.agentB));
  assert.notEqual(fresh.chain_id, first.chain_id);
  assert.equal((await wake(s.agentB, fresh.id)).statusCode, 201);
  assert.equal((await wake(s.agentC, fresh.id)).statusCode, 404);

  // Twelve per hour: B has two, so ten more succeed and the next is refused.
  for (let index = 0; index < 10; index += 1)
    assert.equal((await wake(s.agentB, null)).statusCode, 201);
  const hourly = await wake(s.agentB, null);
  assert.equal(hourly.statusCode, 429, hourly.body);
  assert.equal(hourly.json().error.details.scope, "hour");

  // Thirty per day: earlier wakes outside the hour still count.
  const earlier = new Date(Date.now() - 2 * 60 * 60_000);
  await s.db.insert(projectEvents).values(
    Array.from({ length: 30 }, () => ({
      projectId: s.project.id,
      type: "run.woken",
      actorAgentId: s.agentC.id,
      entityId: s.agentC.id,
      payload: { integration: "codex", handoff_id: null, hop: null },
      occurredAt: earlier
    }))
  );
  const daily = await wake(s.agentC, null);
  assert.equal(daily.statusCode, 429, daily.body);
  assert.equal(daily.json().error.details.scope, "day");
});
