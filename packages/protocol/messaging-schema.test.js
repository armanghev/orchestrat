import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptProjectInvitationResponseSchema,
  chatMessagesQuerySchema,
  createChatRequestSchema,
  inboxSummarySchema,
  sendMessageRequestSchema
} from "./dist/index.js";

const id = "00000000-0000-4000-8000-000000000001";

test("messaging requests keep authenticated authors and bounded references", () => {
  assert.deepEqual(sendMessageRequestSchema.parse({ body_markdown: "hello" }), {
    body_markdown: "hello",
    mentions: [],
    document_ids: []
  });
  assert.throws(() =>
    createChatRequestSchema.parse({
      kind: "group",
      participants: [{ type: "agent", id }]
    })
  );
  assert.equal(
    chatMessagesQuerySchema.parse({ unread_only: "true" }).limit,
    50
  );
  assert.equal(
    inboxSummarySchema.parse({ unread_chats: [] }).unread_chats.length,
    0
  );
});

test("accepted invitations return a project without requiring an agent role", () => {
  const timestamp = "2026-09-24T00:00:00.000Z";
  assert.equal(
    acceptProjectInvitationResponseSchema.parse({
      project: {
        id,
        organization_id: id,
        name: "Project",
        slug: "project",
        description: null,
        status: "active",
        created_at: timestamp,
        updated_at: timestamp,
        archived_at: null
      }
    }).project.id,
    id
  );
});
