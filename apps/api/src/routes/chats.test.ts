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
  const directMention = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${direct.id}/messages`,
    headers: idempotent("alice", "bad-direct-mention"),
    payload: {
      body_markdown: "@bob",
      mentions: [{ type: "human", id: bob.id }]
    }
  });
  assert.equal(directMention.statusCode, 400);

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
