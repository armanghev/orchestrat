import assert from "node:assert/strict";
import test from "node:test";
import { organizationMembers, users } from "@orchestrat/db";
import { eq } from "drizzle-orm";
import { fixture } from "../test/fixture.js";

const alice = { authorization: "Bearer alice" };
const bob = { authorization: "Bearer bob" };
const agentHeaders = (token: string, key?: string) => ({
  authorization: `Bearer ${token}`,
  ...(key ? { "idempotency-key": key } : {})
});

test("messaging adversarial acceptance covers all principal directions and privacy boundaries", async (t) => {
  const { app, db } = await fixture();
  t.after(() => app.close());

  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: alice,
      payload: { name: "Messaging adversarial org" }
    })
  ).json();
  const project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organization.id}/projects`,
      headers: alice,
      payload: { name: "Primary" }
    })
  ).json();
  const otherProject = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organization.id}/projects`,
      headers: alice,
      payload: { name: "Other" }
    })
  ).json();
  await app.inject({ method: "GET", url: "/api/v1/profile", headers: bob });
  const [bobUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, "bob@example.com"));
  const [aliceUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, "alice@example.com"));
  assert.ok(bobUser);
  assert.ok(aliceUser);
  await db.insert(organizationMembers).values({
    organizationId: organization.id,
    userId: bobUser.id,
    role: "member"
  });
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/members`,
        headers: alice,
        payload: { user_id: bobUser.id }
      })
    ).statusCode,
    201
  );

  const createAgent = async (projectId: string, name: string) => {
    const agent = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/agents`,
        headers: alice,
        payload: { name }
      })
    ).json();
    const credential = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/agents/${agent.id}/credentials`,
        headers: alice
      })
    ).json();
    return {
      agent,
      credential: credential.credential,
      token: credential.token as string
    };
  };
  const agentA = await createAgent(project.id, "builder-a");
  const agentB = await createAgent(project.id, "reviewer-b");
  const otherAgent = await createAgent(otherProject.id, "other-project-agent");

  const document = (
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/documents`,
      headers: alice,
      payload: { path: "notes.md", content: "# Notes" }
    })
  ).json().document;
  const otherDocument = (
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${otherProject.id}/documents`,
      headers: alice,
      payload: { path: "other.md", content: "# Other" }
    })
  ).json().document;

  const humanDirect = (
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/chats`,
      headers: { ...alice, "idempotency-key": "human-direct" },
      payload: {
        kind: "direct",
        participants: [{ type: "human", id: bobUser.id }]
      }
    })
  ).json();
  const humanFirst = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${humanDirect.id}/messages`,
    headers: { ...alice, "idempotency-key": "human-first" },
    payload: { body_markdown: "Alice to Bob" }
  });
  const humanSecond = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${humanDirect.id}/messages`,
    headers: { ...bob, "idempotency-key": "human-second" },
    payload: { body_markdown: "Bob to Alice" }
  });
  assert.equal(humanFirst.statusCode, 201, humanFirst.body);
  assert.equal(humanSecond.statusCode, 201, humanSecond.body);
  const humanPage = await app.inject({
    method: "GET",
    url: `/api/v1/chats/${humanDirect.id}/messages?after=0&limit=1`,
    headers: alice
  });
  assert.equal(humanPage.statusCode, 200, humanPage.body);
  assert.equal(humanPage.json().messages.length, 1);
  assert.equal(humanPage.json().has_more, true);
  const humanNext = await app.inject({
    method: "GET",
    url: `/api/v1/chats/${humanDirect.id}/messages?after=${humanPage.json().next_after}&limit=1`,
    headers: alice
  });
  assert.equal(humanNext.json().messages[0].body_markdown, "Bob to Alice");

  const agentDirectReplies = [
    await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: agentHeaders(agentA.token, "agent-direct-a"),
      payload: {
        kind: "direct",
        participants: [{ type: "agent", id: agentB.agent.id }]
      }
    }),
    await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: agentHeaders(agentB.token, "agent-direct-b"),
      payload: {
        kind: "direct",
        participants: [{ type: "agent", id: agentA.agent.id }]
      }
    })
  ];
  assert.deepEqual(
    agentDirectReplies.map((response) => response.statusCode),
    [201, 200]
  );
  const agentDirect = agentDirectReplies[0].json();
  assert.equal(agentDirectReplies[1].json().id, agentDirect.id);
  const agentFirst = await app.inject({
    method: "POST",
    url: `/api/v1/agent/chats/${agentDirect.id}/messages`,
    headers: agentHeaders(agentA.token, "agent-first"),
    payload: { body_markdown: "Agent A to Agent B" }
  });
  const agentSecond = await app.inject({
    method: "POST",
    url: `/api/v1/agent/chats/${agentDirect.id}/messages`,
    headers: agentHeaders(agentB.token, "agent-second"),
    payload: { body_markdown: "Agent B to Agent A" }
  });
  assert.equal(agentFirst.statusCode, 201, agentFirst.body);
  assert.equal(agentSecond.statusCode, 201, agentSecond.body);
  const humanObserver = await app.inject({
    method: "GET",
    url: `/api/v1/chats/${agentDirect.id}/messages`,
    headers: bob
  });
  assert.equal(humanObserver.statusCode, 200, humanObserver.body);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/chats/${agentDirect.id}/messages`,
        headers: { ...bob, "idempotency-key": "observer-write" },
        payload: { body_markdown: "Observer cannot write" }
      })
    ).statusCode,
    403
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/chats/${agentDirect.id}/join`,
        headers: bob
      })
    ).statusCode,
    403
  );

  const group = (
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/chats`,
      headers: { ...alice, "idempotency-key": "human-agent-group" },
      payload: {
        kind: "group",
        name: "Build room",
        participants: [{ type: "agent", id: agentA.agent.id }]
      }
    })
  ).json();
  const groupFirst = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${group.id}/messages`,
    headers: { ...alice, "idempotency-key": "group-first" },
    payload: {
      body_markdown: "Read [notes]",
      mentions: [{ type: "agent", id: agentA.agent.id }],
      document_ids: [document.id]
    }
  });
  assert.equal(groupFirst.statusCode, 201, groupFirst.body);
  const renamed = await app.inject({
    method: "PATCH",
    url: `/api/v1/documents/${document.id}/path`,
    headers: alice,
    payload: { path: "renamed.md", expected_revision: 1 }
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  const groupSecond = await app.inject({
    method: "POST",
    url: `/api/v1/agent/chats/${group.id}/messages`,
    headers: agentHeaders(agentA.token, "group-second"),
    payload: {
      body_markdown: "Agent reply",
      mentions: [{ type: "human", id: aliceUser.id }]
    }
  });
  assert.equal(groupSecond.statusCode, 201, groupSecond.body);
  const groupThird = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${group.id}/messages`,
    headers: { ...alice, "idempotency-key": "group-third" },
    payload: { body_markdown: "Follow up" }
  });
  assert.equal(groupThird.statusCode, 201, groupThird.body);
  const groupPage = await app.inject({
    method: "GET",
    url: `/api/v1/agent/chats/${group.id}/messages?after=0&limit=1`,
    headers: agentHeaders(agentA.token)
  });
  assert.equal(groupPage.statusCode, 200, groupPage.body);
  assert.equal(groupPage.json().messages.length, 1);
  assert.equal(groupPage.json().has_more, true);
  const groupNext = await app.inject({
    method: "GET",
    url: `/api/v1/agent/chats/${group.id}/messages?after=${groupPage.json().next_after}&limit=2`,
    headers: agentHeaders(agentA.token)
  });
  assert.equal(groupNext.json().messages.length, 2);
  assert.equal(groupNext.json().messages[0].body_markdown, "Agent reply");
  assert.equal(groupNext.json().messages[1].body_markdown, "Follow up");
  assert.equal(groupNext.json().messages[0].documents.length, 0);
  assert.equal(groupPage.json().messages[0].documents[0].id, document.id);
  const agentInbox = await app.inject({
    method: "GET",
    url: "/api/v1/agent/inbox",
    headers: agentHeaders(agentA.token)
  });
  assert.deepEqual(
    agentInbox
      .json()
      .unread_chats.sort(
        (left: { chat_id: string }, right: { chat_id: string }) =>
          left.chat_id.localeCompare(right.chat_id)
      ),
    [
      { chat_id: agentDirect.id, unread_count: 1, mention_count: 0 },
      { chat_id: group.id, unread_count: 2, mention_count: 1 }
    ].sort((left, right) => left.chat_id.localeCompare(right.chat_id))
  );

  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/chats`,
        headers: { ...alice, "idempotency-key": "forged-participant" },
        payload: {
          kind: "group",
          name: "Forged",
          participants: [{ type: "agent", id: otherAgent.agent.id }]
        }
      })
    ).statusCode,
    400
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/chats/${group.id}/messages`,
        headers: { ...alice, "idempotency-key": "forged-mention" },
        payload: {
          body_markdown: "forged",
          mentions: [{ type: "agent", id: otherAgent.agent.id }]
        }
      })
    ).statusCode,
    400
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/chats/${group.id}/messages`,
        headers: { ...alice, "idempotency-key": "forged-document" },
        payload: { body_markdown: "forged", document_ids: [otherDocument.id] }
      })
    ).statusCode,
    400
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/api/v1/agent/chats/${group.id}/messages`,
        headers: agentHeaders(otherAgent.token)
      })
    ).statusCode,
    403
  );

  const agentGroup = (
    await app.inject({
      method: "POST",
      url: "/api/v1/agent/chats",
      headers: agentHeaders(agentA.token, "sticky-group"),
      payload: {
        kind: "group",
        name: "Private agents",
        participants: [{ type: "agent", id: agentB.agent.id }]
      }
    })
  ).json();
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/api/v1/chats/${agentGroup.id}/messages`,
        headers: bob
      })
    ).statusCode,
    200
  );
  const joined = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${agentGroup.id}/join`,
    headers: bob
  });
  assert.equal(joined.statusCode, 200, joined.body);
  const removed = await app.inject({
    method: "POST",
    url: `/api/v1/chats/${agentGroup.id}/members`,
    headers: bob,
    payload: {
      action: "remove",
      participant: { type: "human", id: bobUser.id }
    }
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: `/api/v1/chats/${agentGroup.id}/messages`,
        headers: bob
      })
    ).statusCode,
    403
  );
  const bobEvents = await app.inject({
    method: "GET",
    url: `/api/v1/projects/${project.id}/events?limit=100`,
    headers: bob
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

  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/v1/chats/${group.id}/messages/${groupFirst.json().id}`,
        headers: alice
      })
    ).statusCode,
    404
  );
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/v1/chats/${group.id}`,
        headers: alice
      })
    ).statusCode,
    404
  );

  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${otherProject.id}/credentials/${otherAgent.credential.id}/revoke`,
        headers: alice
      })
    ).statusCode,
    200
  );
  const revokedCredential = await app.inject({
    method: "GET",
    url: "/api/v1/agent/inbox",
    headers: agentHeaders(otherAgent.token)
  });
  assert.equal(revokedCredential.statusCode, 401, revokedCredential.body);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents/${agentA.agent.id}/revoke`,
        headers: alice
      })
    ).statusCode,
    200
  );
  const revokedAgent = await app.inject({
    method: "GET",
    url: "/api/v1/agent/inbox",
    headers: agentHeaders(agentA.token)
  });
  assert.equal(revokedAgent.statusCode, 401, revokedAgent.body);
});
