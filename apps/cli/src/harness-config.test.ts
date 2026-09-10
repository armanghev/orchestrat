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
  assert.throws(() =>
    cursor.mcp!.merge(
      JSON.stringify({ mcpServers: { orchestrat: { command: "bad" } } })
    )
  );
  assert.throws(() => cursor.hooks!.merge(JSON.stringify({ version: 2 })));
  const antigravity = harnessConfigPlan("/home/test", "antigravity", command);
  assert.ok(antigravity.hooks);
  assert.throws(() =>
    antigravity.hooks!.merge(JSON.stringify({ orchestrat: { Stop: [] } }))
  );
});

test("OpenCode intentionally has no hook plan", () => {
  assert.equal(
    harnessConfigPlan("/home/test", "opencode", command).hooks,
    undefined
  );
});

test("OpenCode preserves native flat and existing nested server maps", () => {
  const plan = harnessConfigPlan(
    "/home/test",
    "opencode",
    command,
    "/work",
    "global"
  ).mcp!;
  const entry = {
    type: "local",
    command: [command, "mcp", "--integration", "opencode", "--global"],
    enabled: true
  };
  for (const nested of [false, true]) {
    const servers = {
      orchestrat: entry,
      other: { type: "local", command: ["keep"] }
    };
    const existing = { mcp: nested ? { servers } : servers };
    const merged = plan.merge(JSON.stringify(existing));
    assert.deepEqual(JSON.parse(merged), existing);
    const removed = JSON.parse(plan.remove(merged)!);
    assert.deepEqual(nested ? removed.mcp.servers : removed.mcp, {
      other: servers.other
    });
  }
  assert.deepEqual(
    JSON.parse(plan.merge(undefined)).mcp.orchestrat.command,
    entry.command
  );
  assert.throws(() =>
    plan.merge(
      JSON.stringify({
        mcp: { orchestrat: { ...entry, command: ["unrelated"] } }
      })
    )
  );
  assert.throws(() =>
    plan.remove(
      JSON.stringify({
        mcp: { orchestrat: { ...entry, command: ["unrelated"] } }
      })
    )
  );
  assert.equal(
    JSON.parse(
      plan.merge(
        JSON.stringify({ mcp: { orchestrat: { ...entry, enabled: false } } })
      )
    ).mcp.orchestrat.enabled,
    true
  );
});

test("Cursor hook plan preserves unrelated hooks", () => {
  const hooks = harnessConfigPlan("/home/test", "cursor", command).hooks!;
  const existing = JSON.stringify({
    hooks: { sessionStart: [{ command: "other hook" }] }
  });
  const merged = hooks.merge(existing);
  const entries = JSON.parse(merged).hooks.sessionStart;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].command, "other hook");
  assert.deepEqual(JSON.parse(hooks.remove(merged)!), {
    hooks: { sessionStart: [{ command: "other hook" }] },
    version: 1
  });
});

test("global Cursor MCP selects its project through the bridge", () => {
  const plan = harnessConfigPlan(
    "/home/test",
    "cursor",
    command,
    "/work/project",
    "global"
  );
  assert.equal(plan.mcp?.path, "/home/test/.cursor/mcp.json");
  assert.deepEqual(
    JSON.parse(plan.mcp!.merge(undefined)).mcpServers.orchestrat,
    {
      command,
      args: ["mcp", "--integration", "cursor", "--global"]
    }
  );
});

test("every configurable harness can use the global MCP bridge", () => {
  for (const integration of [
    "codex",
    "claude-code",
    "cursor",
    "antigravity",
    "opencode"
  ] as const) {
    const plan = harnessConfigPlan(
      "/home/test",
      integration,
      command,
      "/work/project",
      "global"
    );
    assert.match(plan.mcp!.merge(undefined), /--global/);
  }
});
