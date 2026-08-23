import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCredentialTokenSchema,
  agentPresenceSchema,
  apiErrorResponseSchema,
  apiErrorSchema,
  claimResponseSchema,
  createDocumentRequestSchema,
  documentConflictDetailsSchema,
  documentPathSchema,
  eventSchema,
  heartbeatRequestSchema,
  projectEventsResponseSchema
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
});
