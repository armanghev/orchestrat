import assert from "node:assert/strict";
import test from "node:test";
import {
  agentBulkCreateTasksRequestSchema,
  agentBulkUpdateTasksRequestSchema,
  agentUpdateTaskRequestSchema,
  updateTaskRequestSchema
} from "./dist/index.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("agent updates accept a human-selectable status; humans keep the move route", () => {
  assert.deepEqual(
    agentUpdateTaskRequestSchema.parse({
      status: "ready",
      acknowledged_through: 0,
      expected_version: 1
    }),
    { status: "ready", acknowledged_through: 0, expected_version: 1 }
  );
  assert.equal(
    agentUpdateTaskRequestSchema.safeParse({
      status: "claimed",
      expected_version: 1
    }).success,
    false
  );
  assert.equal(
    agentUpdateTaskRequestSchema.safeParse({
      acknowledged_through: 3,
      expected_version: 1
    }).success,
    false
  );
  assert.deepEqual(
    updateTaskRequestSchema.parse({
      title: "Kept",
      status: "done",
      expected_version: 1
    }),
    { title: "Kept", expected_version: 1 }
  );
});

test("bulk task requests hold 1-50 items and distinct task ids", () => {
  assert.equal(
    agentBulkCreateTasksRequestSchema.safeParse({ tasks: [] }).success,
    false
  );
  assert.equal(
    agentBulkCreateTasksRequestSchema.safeParse({
      tasks: Array.from({ length: 51 }, (_, n) => ({ title: `T${n}` }))
    }).success,
    false
  );
  assert.equal(
    agentBulkCreateTasksRequestSchema.safeParse({
      tasks: [{ title: "Done", status: "done" }]
    }).success,
    false
  );
  const duplicate = agentBulkUpdateTasksRequestSchema.safeParse({
    tasks: [
      { task_id: id(1), priority: "high", expected_version: 1 },
      { task_id: id(2), status: "ready", expected_version: 1 },
      { task_id: id(1), status: "done", expected_version: 1 }
    ]
  });
  assert.equal(duplicate.success, false);
  assert.deepEqual(duplicate.error.issues[0].path, ["tasks", 2, "task_id"]);
  assert.equal(
    agentBulkUpdateTasksRequestSchema.safeParse({
      tasks: [{ task_id: id(1), status: "backlog", expected_version: 2 }]
    }).success,
    true
  );
});
