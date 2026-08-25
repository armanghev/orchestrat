import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAntigravityHook } from "./antigravity-hooks.js";
import { normalizeCursorHook } from "./cursor-hooks.js";

const cursor = (hook_event_name: string, extra = {}) => ({
  hook_event_name,
  conversation_id: "cursor-session",
  workspace_roots: ["/repo"],
  ...extra
});

test("Cursor normalizes lifecycle and failure hooks", () => {
  assert.equal(
    normalizeCursorHook(cursor("sessionStart")).event,
    "session.started"
  );
  assert.equal(
    normalizeCursorHook(cursor("sessionEnd")).event,
    "session.ended"
  );
  assert.equal(
    normalizeCursorHook(cursor("postToolUseFailure", { error_message: "x" }))
      .event,
    "run.failed"
  );
  assert.equal(
    normalizeCursorHook(cursor("stop")).session_id,
    normalizeCursorHook(cursor("sessionStart")).session_id
  );
  assert.throws(() =>
    normalizeCursorHook(cursor("sessionStart", { conversation_id: "" }))
  );
  assert.throws(() =>
    normalizeCursorHook(cursor("sessionStart", { workspace_roots: [] }))
  );
  assert.equal(
    normalizeCursorHook(cursor("postToolUseFailure", { error_message: "x" }))
      .error,
    "x"
  );
  assert.equal(
    normalizeCursorHook(
      cursor("postToolUseFailure", { error: "x".repeat(3000) })
    ).error?.length,
    2000
  );
});

test("Antigravity uses explicit event names and deterministic IDs", () => {
  const input = { conversationId: "agy-session", workspacePaths: ["/repo"] };
  assert.equal(
    normalizeAntigravityHook("PreInvocation", input).event,
    "session.started"
  );
  assert.equal(normalizeAntigravityHook("Stop", input).event, "session.ended");
  assert.equal(
    normalizeAntigravityHook("Stop", { ...input, error: "failed" }).event,
    "run.failed"
  );
  assert.equal(
    normalizeAntigravityHook("Stop", input).session_id,
    normalizeAntigravityHook("PreInvocation", input).session_id
  );
  assert.throws(() =>
    normalizeAntigravityHook("Stop", { ...input, conversationId: "" })
  );
  assert.throws(() => normalizeAntigravityHook("PostInvocation", input));
});
