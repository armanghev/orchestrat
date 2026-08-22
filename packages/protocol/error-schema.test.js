import assert from "node:assert/strict";
import test from "node:test";
import { apiErrorResponseSchema, apiErrorSchema } from "./dist/index.js";

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
