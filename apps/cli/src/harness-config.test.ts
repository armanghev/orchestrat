import assert from "node:assert/strict";
import test from "node:test";
import { harnessConfigPlan } from "./harness-config.js";

const command = "/tmp/orchestrat";

test("new harness plans use native paths and are idempotent", () => {
  for (const integration of ["cursor", "antigravity", "opencode"] as const) {
    const plan = harnessConfigPlan("/home/test", integration, command);
    assert.ok(plan.mcp);
    const first = plan.mcp.merge(undefined);
    assert.equal(plan.mcp.merge(first), first);
    assert.equal(plan.mcp.remove(first)?.includes("orchestrat"), false);
    if (plan.hooks) {
      const hooks = plan.hooks.merge(undefined);
      assert.equal(plan.hooks.merge(hooks), hooks);
      assert.equal(plan.hooks.remove(hooks)?.includes("orchestrat"), false);
    }
  }
});

test("new harness plans reject managed conflicts", () => {
  const cursor = harnessConfigPlan("/home/test", "cursor", command);
  assert.ok(cursor.mcp);
  assert.throws(() => cursor.mcp!.merge(JSON.stringify({ mcpServers: { orchestrat: { command: "bad" } } })));
  const antigravity = harnessConfigPlan("/home/test", "antigravity", command);
  assert.ok(antigravity.hooks);
  assert.throws(() => antigravity.hooks!.merge(JSON.stringify({ orchestrat: { Stop: [] } })));
});

test("OpenCode intentionally has no hook plan", () => {
  assert.equal(harnessConfigPlan("/home/test", "opencode", command).hooks, undefined);
});
