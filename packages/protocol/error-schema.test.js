import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCredentialTokenSchema,
  agentPresenceSchema,
  apiErrorResponseSchema,
  apiErrorSchema,
  attachmentDownloadQuerySchema,
  attachmentPartsRequestSchema,
  claimResponseSchema,
  createAttachmentUploadRequestSchema,
  createDocumentFolderRequestSchema,
  createDocumentRequestSchema,
  documentAttachmentUploadParamsSchema,
  documentConflictDetailsSchema,
  documentHistoryQuerySchema,
  documentPathSchema,
  editDocumentRequestSchema,
  eventSchema,
  heartbeatRequestSchema,
  projectEventsResponseSchema,
  realtimeEventEnvelopeSchema,
  realtimeProjectParamsSchema,
  realtimeSocketQuerySchema,
  realtimeTicketRequestSchema,
  realtimeTicketResponseSchema,
  updateDocumentRequestSchema
} from "./dist/index.js";

const taskError = {
  error: {
    code: "TASK_VERSION_CONFLICT",
    message: "The task changed.",
    details: {},
    request_id: "req_test"
  }
};

test("preserves task errors on the full wire schema", () => {
  assert.equal(
    apiErrorResponseSchema.parse(taskError).error.code,
    "TASK_VERSION_CONFLICT"
  );
});

test("normalizes task errors for the legacy dashboard schema", () => {
  assert.equal(apiErrorSchema.parse(taskError).error.code, "INTERNAL_ERROR");
});

test("accepts the coordination wire contracts", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const timestamp = "2026-08-22T00:00:00.000Z";
  const claim = {
    id,
    project_id: id,
    task_id: id,
    agent_id: id,
    session_id: id,
    status: "active",
    claimed_at: timestamp,
    lease_expires_at: timestamp,
    released_at: null,
    completed_at: null
  };

  assert.equal(
    claimResponseSchema.parse({ claim, claim_token: "x".repeat(32) }).claim.id,
    id
  );
  assert.equal(
    agentPresenceSchema.parse({
      agent_id: id,
      project_id: id,
      session_id: id,
      status: "online",
      last_heartbeat_at: timestamp,
      current_task_id: null
    }).status,
    "online"
  );
  assert.equal(
    projectEventsResponseSchema.parse({ events: [], next_cursor: null }).events
      .length,
    0
  );
  assert.equal(
    claimResponseSchema.parse({
      claim: { ...claim, status: "revoked" },
      claim_token: "x".repeat(32)
    }).claim.status,
    "revoked"
  );
});

test("rejects malformed heartbeat and preserves stable claim errors", () => {
  assert.throws(() => heartbeatRequestSchema.parse({ session_id: "bad" }));
  assert.throws(() => agentCredentialTokenSchema.parse("x".repeat(64)));
  assert.equal(
    agentCredentialTokenSchema.parse(`orch_agent_${"x".repeat(32)}`),
    `orch_agent_${"x".repeat(32)}`
  );
  assert.equal(
    apiErrorResponseSchema.parse({
      error: {
        code: "TASK_ALREADY_CLAIMED",
        message: "Task is already claimed.",
        details: { claim_id: "claim_1" },
        request_id: "req_test"
      }
    }).error.code,
    "TASK_ALREADY_CLAIMED"
  );
});

test("preserves the legacy event schema", () => {
  const event = {
    type: "agent.heartbeat",
    occurredAt: "2026-08-22T00:00:00.000Z"
  };

  assert.deepEqual(eventSchema.parse(event), event);
});

test("accepts normalized document paths and revision conflicts", () => {
  assert.equal(documentPathSchema.parse("docs/README.md"), "docs/README.md");
  assert.throws(() => documentPathSchema.parse("/README.md"));
  assert.throws(() => documentPathSchema.parse("docs//README.md"));
  assert.throws(() => documentPathSchema.parse("docs/../README.md"));
  assert.throws(() => documentPathSchema.parse("docs/\0README.md"));
  assert.throws(() => documentPathSchema.parse("docs\\README.md"));

  assert.deepEqual(
    documentConflictDetailsSchema.parse({
      current_revision: 19,
      base_revision: 18
    }),
    { current_revision: 19, base_revision: 18 }
  );
  assert.equal(
    createDocumentRequestSchema.parse({ path: "README.md", content: "# Notes" })
      .content,
    "# Notes"
  );
  assert.throws(() =>
    createDocumentRequestSchema.parse({ path: "src/index.ts", content: "" })
  );
  assert.equal(
    createDocumentFolderRequestSchema.parse({ path: "docs/guides" }).path,
    "docs/guides"
  );
});

test("validates document edit, history, autosave, and attachment contracts", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(
    editDocumentRequestSchema.parse({
      base_revision: 2,
      edits: [{ old_text: "before", new_text: "after" }]
    }).edits[0],
    { old_text: "before", new_text: "after" }
  );
  assert.throws(() =>
    editDocumentRequestSchema.parse({
      base_revision: 2,
      edits: [{ old_text: "", new_text: "after" }]
    })
  );
  assert.equal(documentHistoryQuerySchema.parse({ limit: 50 }).view, "detail");
  assert.equal(
    updateDocumentRequestSchema.parse({
      base_revision: 2,
      content: "after",
      save_kind: "autosave"
    }).save_kind,
    "autosave"
  );
  assert.deepEqual(
    documentAttachmentUploadParamsSchema.parse({
      documentId: id,
      uploadId: id
    }),
    { documentId: id, uploadId: id }
  );
  assert.equal(
    createAttachmentUploadRequestSchema.parse({
      filename: "notes.txt",
      size_bytes: 2 * 1024 * 1024 * 1024
    }).content_type,
    "application/octet-stream"
  );
  assert.throws(() =>
    createAttachmentUploadRequestSchema.parse({
      filename: "../notes.txt",
      size_bytes: 1
    })
  );
  assert.throws(() =>
    attachmentPartsRequestSchema.parse({
      part_numbers: Array.from({ length: 101 }, (_, index) => index + 1)
    })
  );
  assert.equal(
    attachmentDownloadQuerySchema.parse({ ticket: "ticket" }).ticket,
    "ticket"
  );
});

test("accepts project realtime ticket and event contracts", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const expires_at = "2026-08-22T00:00:30.000Z";
  assert.deepEqual(realtimeTicketRequestSchema.parse({ project_id: id }), {
    project_id: id
  });
  assert.equal(
    realtimeTicketResponseSchema.parse({
      ticket: "t".repeat(43),
      expires_at
    }).expires_at,
    expires_at
  );
  assert.equal(
    realtimeProjectParamsSchema.parse({ projectId: id }).projectId,
    id
  );
  assert.equal(
    realtimeSocketQuerySchema.parse({ ticket: "t".repeat(43) }).ticket.length,
    43
  );
  assert.deepEqual(
    realtimeEventEnvelopeSchema.parse({
      project_id: id,
      sequence: 7,
      event_type: "task.updated",
      entity_type: "task",
      entity_id: id
    }).sequence,
    7
  );
  assert.equal(
    realtimeEventEnvelopeSchema.parse({
      project_id: id,
      sequence: 8,
      event_type: "hook.triggered",
      entity_type: "hook",
      entity_id: null
    }).entity_type,
    "hook"
  );
});

test("rejects malformed realtime tickets and non-monotonic event sequences", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.throws(() => realtimeTicketRequestSchema.parse({ project_id: "bad" }));
  assert.throws(() =>
    realtimeTicketResponseSchema.parse({
      ticket: "too-short",
      expires_at: "2026-08-22T00:00:30.000Z"
    })
  );
  assert.throws(() =>
    realtimeSocketQuerySchema.parse({ ticket: "x".repeat(32) + "." })
  );
  assert.throws(() =>
    realtimeEventEnvelopeSchema.parse({
      project_id: id,
      sequence: 0,
      event_type: "task.updated",
      entity_type: "task",
      entity_id: id
    })
  );
  assert.throws(() =>
    realtimeEventEnvelopeSchema.parse({
      project_id: id,
      sequence: 1,
      event_type: "task.updated",
      entity_type: "hook",
      entity_id: id
    })
  );
});
