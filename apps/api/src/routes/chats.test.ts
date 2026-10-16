import assert from "node:assert/strict";
import test from "node:test";
import { chatMessages, organizationMembers, users } from "@orchestrat/db";
import { eq } from "drizzle-orm";
import { fixture } from "../test/fixture.js";

const human = (name: "alice" | "bob") => ({
  authorization: `Bearer ${name}`
});
const idempotent = (name: "alice" | "bob", key: string) => ({
  ...human(name),
  "idempotency-key": key
});

test("humans and offline agents exchange immutable project-scoped messages", async (t) => {
  const { app, db } = await fixture();
  t.after(() => app.close());
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: human("alice"),
      payload: { name: "Chat org" }
    })
  ).json();
  const project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organization.id}/projects`,
      headers: human("alice"),
      payload: { name: "Chat project" }
    })
  ).json();
  await app.inject({
    method: "GET",
    url: "/api/v1/profile",
    headers: human("bob")
  });
  const [bob] = await db
    .select()
    .from(users)
    .where(eq(users.email, "bob@example.com"));
  assert.ok(bob);
  await db.insert(organizationMembers).values({
    organizationId: organization.id,
    userId: bob.id,
    role: "member"
  });
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/members`,
        headers: human("alice"),
        payload: { user_id: bob.id }
      })
    ).statusCode,
    201
  );

  const createAgent = async (name: string) => {
    const agent = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents`,
        headers: human("alice"),
        payload: { name }
      })
    ).json();
    const credential = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents/${agent.id}/credentials`,
        headers: human("alice")
      })
    ).json();
    return { agent, token: credential.token as string };
  };
  const agentA = await createAgent("agent-a");
  const agentB = await createAgent("agent-b");

  const directResponse = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/chats`,
    headers: idempotent("alice", "human-direct"),
    payload: {
      kind: "direct",
      participants: [{ type: "human", id: bob.id }]
    }
  });
  assert.equal(directResponse.statusCode, 201, directResponse.body);
  const direct = directResponse.json();
  const sameDirect = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/chats`,
    headers: idempotent("bob", "same-human-direct"),
    payload: {
      kind: "direct",
      participants: [{ type: "human", id: direct.creator.id }]
    }
  });
  assert.equal(sameDirect.statusCode, 200, sameDirect.body);
  assert.equal(sameDirect.json().id, direct.id);

  const sent = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${direct.id}/messages`,
    headers: idempotent("alice", "hello-bob"),
    payload: { body_markdown: "Hello Bob" }
  });
  assert.equal(sent.statusCode, 201, sent.body);
  const replay = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${direct.id}/messages`,
    headers: idempotent("alice", "hello-bob"),
    payload: { body_markdown: "Hello Bob" }
  });
  assert.equal(replay.json().id, sent.json().id);
  assert.equal(
    (
      await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.chatId, direct.id))
    ).length,
    1
  );
  const bobInbox = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${project.id}/inbox`,
    headers: human("bob")
  });
  assert.deepEqual(bobInbox.json().unread_chats, [
    { chat_id: direct.id, unread_count: 1, mention_count: 0 }
  ]);
  const read = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${direct.id}/read`,
    headers: human("bob"),
    payload: { through_message_id: sent.json().id }
  });
  assert.equal(read.json().last_read_sequence, 1);
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/v1/chats/${direct.id}/messages/${sent.json().id}`,
        headers: human("alice"),
        payload: { body_markdown: "edited" }
      })
    ).statusCode,
    404
  );

  const document = (
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/documents`,
      headers: human("alice"),
      payload: { path: "notes.md", content: "# Notes" }
    })
  ).json().document;
  const group = (
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/chats`,
      headers: idempotent("alice", "human-agent-group"),
      payload: {
        kind: "group",
        name: "Work",
        participants: [{ type: "agent", id: agentA.agent.id }]
      }
    })
  ).json();
  const groupMessage = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${group.id}/messages`,
    headers: idempotent("alice", "agent-mention"),
    payload: {
      body_markdown: "@agent-a please read #notes",
      mentions: [{ type: "agent", id: agentA.agent.id }],
      document_ids: [document.id]
    }
  });
  assert.equal(groupMessage.statusCode, 201, groupMessage.body);
  assert.equal(groupMessage.json().author.name, "alice");
  assert.equal(groupMessage.json().mentions[0].name, "agent-a");
  assert.equal(groupMessage.json().documents[0].path, "notes.md");
  const agentInbox = await app.inject({
    method: "GET",
    url: "/api/v1/agent/inbox",
    headers: { authorization: `Bearer ${agentA.token}` }
  });
  assert.deepEqual(agentInbox.json().unread_chats, [
    { chat_id: group.id, unread_count: 1, mention_count: 1 }
  ]);
  // Direct chats accept mentions; they are still validated against the chat's
  // participants.
  const directMention = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${direct.id}/messages`,
    headers: idempotent("alice", "direct-mention"),
    payload: {
      body_markdown: "@bob",
      mentions: [{ type: "human", id: bob.id }]
    }
  });
  assert.equal(directMention.statusCode, 201, directMention.body);
  assert.deepEqual(
    directMention.json().mentions.map(({ type, id }: any) => ({ type, id })),
    [{ type: "human", id: bob.id }]
  );
  const directOutsiderMention = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${direct.id}/messages`,
    headers: idempotent("alice", "bad-direct-mention"),
    payload: {
      body_markdown: "@agent",
      mentions: [{ type: "agent", id: agentA.agent.id }]
    }
  });
  assert.equal(directOutsiderMention.statusCode, 400);

  const agentGroup = (
    await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: {
        authorization: `Bearer ${agentA.token}`,
        "idempotency-key": "agents-only"
      },
      payload: {
        kind: "group",
        name: "Agents",
        participants: [{ type: "agent", id: agentB.agent.id }]
      }
    })
  ).json();
  const observed = await app.inject({
    method: "GET",
    url: `/api/v1/chats/${agentGroup.id}/messages`,
    headers: human("bob")
  });
  assert.equal(observed.statusCode, 200, observed.body);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/chats/${agentGroup.id}/messages`,
        headers: idempotent("bob", "observer-send"),
        payload: { body_markdown: "not allowed" }
      })
    ).statusCode,
    403
  );
  const joined = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${agentGroup.id}/join`,
    headers: human("bob")
  });
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal(joined.json().has_human, true);
  assert.equal(joined.json().can_manage, true);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/api/v1/chats/${agentGroup.id}`,
        headers: human("alice")
      })
    ).statusCode,
    403
  );
  const removeCreator = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${agentGroup.id}/members`,
    headers: human("bob"),
    payload: {
      action: "remove",
      participant: { type: "agent", id: agentA.agent.id }
    }
  });
  assert.equal(removeCreator.statusCode, 200, removeCreator.body);
  const staleCreateReplay = await app.inject({
    method: "POST",
    url: "/api/v1/agent/chats",
    headers: {
      authorization: `Bearer ${agentA.token}`,
      "idempotency-key": "agents-only"
    },
    payload: {
      kind: "group",
      name: "Agents",
      participants: [{ type: "agent", id: agentB.agent.id }]
    }
  });
  assert.equal(staleCreateReplay.statusCode, 403);
  const lastManager = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${agentGroup.id}/members`,
    headers: human("bob"),
    payload: {
      action: "remove",
      participant: { type: "human", id: bob.id }
    }
  });
  assert.equal(lastManager.statusCode, 409);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/chats/${agentGroup.id}/members`,
        headers: human("bob"),
        payload: {
          action: "add",
          participant: { type: "agent", id: agentA.agent.id }
        }
      })
    ).statusCode,
    200
  );
  const removed = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${agentGroup.id}/members`,
    headers: human("bob"),
    payload: {
      action: "remove",
      participant: { type: "human", id: bob.id }
    }
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/api/v1/chats/${agentGroup.id}`,
        headers: human("bob")
      })
    ).statusCode,
    403
  );

  const bobEvents = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${project.id}/events?limit=100`,
    headers: human("bob")
  });
  assert.equal(bobEvents.statusCode, 200, bobEvents.body);
  assert.equal(
    bobEvents
      .json()
      .events.some(
        (event: { entity_id: string }) => event.entity_id === agentGroup.id
      ),
    false
  );
  const agentEvents = await app.inject({
    method: "GET",
    url: "/api/v1/agent/events?limit=100",
    headers: { authorization: `Bearer ${agentB.token}` }
  });
  assert.equal(agentEvents.statusCode, 200, agentEvents.body);
  assert.equal(
    agentEvents
      .json()
      .events.some(
        (event: { entity_id: string }) => event.entity_id === agentGroup.id
      ),
    true
  );

  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${project.id}/members/${bob.id}`,
        headers: human("alice")
      })
    ).statusCode,
    200
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/members`,
        headers: human("alice"),
        payload: { user_id: bob.id }
      })
    ).statusCode,
    201
  );
  const unauthorizedReplay = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/chats`,
    headers: idempotent("bob", "same-human-direct"),
    payload: {
      kind: "direct",
      participants: [{ type: "human", id: direct.creator.id }]
    }
  });
  assert.equal(unauthorizedReplay.statusCode, 403);
  const restoredDirect = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${project.id}/chats`,
    headers: idempotent("bob", "restore-human-direct"),
    payload: {
      kind: "direct",
      participants: [{ type: "human", id: direct.creator.id }]
    }
  });
  assert.equal(restoredDirect.statusCode, 200, restoredDirect.body);
  assert.equal(restoredDirect.json().id, direct.id);
});

test("inbox aggregates unread counts across many participant chats", async (t) => {
  const { app, db } = await fixture();
  t.after(() => app.close());
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: human("alice"),
      payload: { name: "Inbox org" }
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
  const project = await createProject("Inbox project");
  const otherProject = await createProject("Other inbox project");
  await app.inject({
    method: "GET",
    url: "/api/v1/profile",
    headers: human("bob")
  });
  const [bob] = await db
    .select()
    .from(users)
    .where(eq(users.email, "bob@example.com"));
  assert.ok(bob);
  await db.insert(organizationMembers).values({
    organizationId: organization.id,
    userId: bob.id,
    role: "member"
  });
  for (const currentProject of [project, otherProject])
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${currentProject.id}/members`,
          headers: human("alice"),
          payload: { user_id: bob.id }
        })
      ).statusCode,
      201
    );

  const createGroup = async (
    currentProject: { id: string },
    name: string,
    key: string
  ) =>
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${currentProject.id}/chats`,
        headers: idempotent("alice", key),
        payload: {
          kind: "group",
          name,
          participants: [{ type: "human", id: bob.id }]
        }
      })
    ).json();
  const sendHumanMessage = async (
    chatId: string,
    actor: "alice" | "bob",
    key: string,
    mentions: { type: "human"; id: string }[] = []
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/chats/${chatId}/messages`,
      headers: idempotent(actor, key),
      payload: { body_markdown: key, mentions }
    });

  const chats = await Promise.all(
    Array.from({ length: 2 }, (_, index) =>
      createGroup(project, `Inbox ${index}`, `inbox-chat-${index}`)
    )
  );
  const first = await sendHumanMessage(chats[0].id, "alice", "first-mention", [
    { type: "human", id: bob.id }
  ]);
  const ownReply = await sendHumanMessage(chats[0].id, "bob", "own-reply");
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(ownReply.statusCode, 201, ownReply.body);
  const unreadAfterRead = await sendHumanMessage(
    chats[0].id,
    "alice",
    "unread-after-read",
    [{ type: "human", id: bob.id }]
  );
  await app.inject({
    method: "POST",
    url: `/api/v1/chats/${chats[0].id}/read`,
    headers: human("bob"),
    payload: { through_message_id: first.json().id }
  });
  assert.equal(unreadAfterRead.statusCode, 201, unreadAfterRead.body);
  await sendHumanMessage(chats[1].id, "alice", "second-mention", [
    { type: "human", id: bob.id }
  ]);
  await sendHumanMessage(chats[1].id, "alice", "second-unread");

  const measureInbox = async () => {
    let selectCount = 0;
    const pool = db.$client as unknown as {
      query: (...args: unknown[]) => Promise<unknown>;
    };
    const originalQueryMethod = pool.query;
    const originalQuery = pool.query.bind(db.$client);
    pool.query = async (...args: unknown[]) => {
      const config = args[0] as unknown;
      const statement =
        typeof config === "string"
          ? config
          : config && typeof config === "object" && "text" in config
            ? String(config.text)
            : "";
      if (/^\s*select\b/i.test(statement)) selectCount++;
      return originalQuery(...args);
    };
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/inbox`,
        headers: human("bob")
      });
      return { response, selectCount };
    } finally {
      pool.query = originalQueryMethod;
    }
  };
  const baseline = await measureInbox();
  assert.equal(baseline.response.statusCode, 200, baseline.response.body);

  const additionalChats = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      createGroup(project, `Inbox ${index + 2}`, `inbox-chat-${index + 2}`)
    )
  );
  chats.push(...additionalChats);
  for (const chat of additionalChats)
    await sendHumanMessage(chat.id, "alice", `message-${chat.id}`);

  const betaChat = await createGroup(
    otherProject,
    "Other project chat",
    "other-project-chat"
  );
  await sendHumanMessage(betaChat.id, "alice", "other-project-message");

  const createAgent = async (name: string) => {
    const agent = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents`,
        headers: human("alice"),
        payload: { name }
      })
    ).json();
    const credential = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents/${agent.id}/credentials`,
        headers: human("alice")
      })
    ).json();
    return { agent, token: credential.token as string };
  };
  const agentA = await createAgent("inbox-agent-a");
  const agentB = await createAgent("inbox-agent-b");
  const agentOnlyChat = (
    await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: {
        authorization: `Bearer ${agentA.token}`,
        "idempotency-key": "agent-only-inbox-chat"
      },
      payload: {
        kind: "group",
        name: "Agent only inbox chat",
        participants: [{ type: "agent", id: agentB.agent.id }]
      }
    })
  ).json();
  await app.inject({
    method: "POST",
    url: `/api/v1/agent/chats/${agentOnlyChat.id}/messages`,
    headers: {
      authorization: `Bearer ${agentA.token}`,
      "idempotency-key": "agent-only-inbox-message"
    },
    payload: { body_markdown: "Visible in project, not a participant" }
  });

  const expanded = await measureInbox();
  const inbox = expanded.response;
  assert.equal(inbox.statusCode, 200, inbox.body);
  // Project lock, membership, default branch, then one inbox query.
  assert.equal(baseline.selectCount, 4);
  assert.equal(expanded.selectCount, baseline.selectCount);
  const expected = [
    { chat_id: chats[0].id, unread_count: 1, mention_count: 1 },
    { chat_id: chats[1].id, unread_count: 2, mention_count: 1 },
    ...chats.slice(2).map((chat: { id: string }) => ({
      chat_id: chat.id,
      unread_count: 1,
      mention_count: 0
    }))
  ].sort((left, right) => left.chat_id.localeCompare(right.chat_id));
  assert.deepEqual(
    inbox
      .json()
      .unread_chats.sort(
        (left: { chat_id: string }, right: { chat_id: string }) =>
          left.chat_id.localeCompare(right.chat_id)
      ),
    expected
  );
});
