import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConfig, readConfig } from "./config.js";
import { disconnectLocal } from "./diagnostics.js";
import { harnessConfigPlan } from "./harness-config.js";
import type { CredentialStore } from "./keychain.js";
import { parseInvocationArgs } from "./main.js";
import { readOptional } from "./safe-files.js";
import { runSetup } from "./setup.js";

const command = "/tmp/orchestrat";
const on = { autoContinue: true };
const rewake = { autoContinue: true, rewake: true };

test("default plans are unchanged: no Stop, timeout or budget", () => {
  for (const integration of [
    "codex",
    "claude-code",
    "cursor",
    "antigravity"
  ] as const) {
    const before = harnessConfigPlan("/home/test", integration, command);
    const off = harnessConfigPlan(
      "/home/test",
      integration,
      command,
      "/home/test",
      "project",
      {}
    );
    const mcp = before.mcp!.merge(undefined);
    assert.equal(off.mcp!.merge(undefined), mcp);
    assert.doesNotMatch(mcp, /wait-budget|tool_timeout_sec|timeoutSeconds/);
    const hooks = before.hooks?.merge(undefined);
    // Antigravity's existing Stop lifecycle entry predates attention.
    if (integration !== "antigravity")
      assert.doesNotMatch(hooks ?? "", /"Stop"|"stop"|loop_limit/);
  }
});

test("Claude Stop and rewake entries install idempotently and remove only ours", () => {
  const user = {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }]
    }
  };
  const plan = harnessConfigPlan(
    "/home/test",
    "claude-code",
    command,
    "/home/test",
    "project",
    rewake
  );
  const merged = plan.hooks!.merge(JSON.stringify(user));
  assert.equal(plan.hooks!.merge(merged), merged);
  const stop = JSON.parse(merged).hooks.Stop;
  assert.deepEqual(stop[0], user.hooks.Stop[0]);
  assert.deepEqual(stop[1], {
    hooks: [
      {
        type: "command",
        command: "'/tmp/orchestrat' hook claude-code --event Stop"
      },
      {
        type: "command",
        command: "'/tmp/orchestrat' hook claude-code --event Stop --watch",
        async: true,
        asyncRewake: true,
        timeout: 3600
      }
    ]
  });
  // Dropping rewake keeps the synchronous entry only.
  const syncOnly = harnessConfigPlan(
    "/home/test",
    "claude-code",
    command,
    "/home/test",
    "project",
    on
  ).hooks!.merge(merged);
  assert.equal(JSON.parse(syncOnly).hooks.Stop[1].hooks.length, 1);
  // Opting out and removal both leave the user's Stop handler alone.
  const off = harnessConfigPlan("/home/test", "claude-code", command).hooks!;
  assert.deepEqual(JSON.parse(off.merge(merged)).hooks.Stop, user.hooks.Stop);
  const removed = JSON.parse(plan.hooks!.remove(merged)!);
  assert.deepEqual(removed.hooks.Stop, user.hooks.Stop);
  assert.equal(removed.hooks.SessionStart, undefined);
  assert.throws(() =>
    plan.hooks!.merge(
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/x/orchestrat hook claude-code --event Stop"
                }
              ]
            }
          ]
        }
      })
    )
  );
});

test("Codex gets a Stop entry, tool_timeout_sec and the wait budget only when opted in", () => {
  const plan = harnessConfigPlan(
    "/home/test",
    "codex",
    command,
    "/home/test",
    "project",
    on
  );
  const hooks = plan.hooks!.merge(undefined);
  assert.equal(plan.hooks!.merge(hooks), hooks);
  assert.deepEqual(JSON.parse(hooks).hooks.Stop, [
    {
      hooks: [
        {
          type: "command",
          command: "'/tmp/orchestrat' hook codex --event Stop"
        }
      ]
    }
  ]);
  const user =
    '[mcp_servers.orchestrat]\ncommand = "/tmp/orchestrat"\nargs = ["mcp","--integration","codex"]\nenv = { A = "1" }\n\n[other]\nx = 1\n';
  const toml = plan.mcp!.merge(user);
  assert.equal(plan.mcp!.merge(toml), toml);
  assert.match(
    toml,
    /args = \["mcp", "--integration", "codex", "--wait-budget-seconds", "600"\]\ntool_timeout_sec = 660\nenv = \{ A = "1" \}/
  );
  assert.match(toml, /\[other\]\nx = 1/);
  const off = harnessConfigPlan("/home/test", "codex", command).mcp!;
  // Unchanged entries keep the user's formatting byte for byte.
  assert.equal(off.merge(user), user);
  const reverted = off.merge(toml);
  assert.doesNotMatch(reverted, /tool_timeout_sec|wait-budget/);
  assert.equal(off.merge(reverted), reverted);
  assert.doesNotMatch(plan.mcp!.remove(toml)!, /mcp_servers\.orchestrat/);
  assert.doesNotMatch(plan.hooks!.remove(hooks) ?? "", /orchestrat/);
});

test("Cursor stop entry carries loop_limit 2 and keeps the per-turn lifecycle entries", () => {
  const plan = harnessConfigPlan(
    "/home/test",
    "cursor",
    command,
    "/home/test",
    "project",
    on
  );
  const merged = plan.hooks!.merge(
    JSON.stringify({ version: 1, hooks: { stop: [{ command: "echo mine" }] } })
  );
  assert.equal(plan.hooks!.merge(merged), merged);
  const hooks = JSON.parse(merged).hooks;
  assert.deepEqual(hooks.stop, [
    { command: "echo mine" },
    { command: "'/tmp/orchestrat' hook cursor --event stop", loop_limit: 2 }
  ]);
  assert.ok(hooks.sessionStart && hooks.sessionEnd && hooks.postToolUseFailure);
  const removed = JSON.parse(plan.hooks!.remove(merged)!);
  assert.deepEqual(removed.hooks, { stop: [{ command: "echo mine" }] });
});

test("Antigravity gets timeoutSeconds 660 and the wait budget; hooks stay the same", () => {
  const plan = harnessConfigPlan(
    "/home/test",
    "antigravity",
    command,
    "/home/test",
    "project",
    on
  );
  const mcp = plan.mcp!.merge(undefined);
  assert.equal(plan.mcp!.merge(mcp), mcp);
  assert.deepEqual(JSON.parse(mcp).mcpServers.orchestrat, {
    command,
    args: [
      "mcp",
      "--integration",
      "antigravity",
      "--wait-budget-seconds",
      "600"
    ],
    timeoutSeconds: 660
  });
  const off = harnessConfigPlan("/home/test", "antigravity", command);
  assert.equal(plan.hooks!.merge(undefined), off.hooks!.merge(undefined));
  assert.equal(
    JSON.parse(off.mcp!.merge(mcp)).mcpServers.orchestrat.timeoutSeconds,
    undefined
  );
  assert.equal(
    JSON.parse(off.mcp!.remove(mcp)!).mcpServers.orchestrat,
    undefined
  );
});

test("config preserves attention and waker keys and rejects malformed attention", () => {
  const config = parseConfig({
    version: 1,
    projects: {},
    attention: { continue_on_stop: ["codex", "codex"], rewake: true },
    waker: { enabled: true, agents: [{ id: "x" }] }
  });
  assert.deepEqual(config.attention, {
    continue_on_stop: ["codex"],
    rewake: true
  });
  assert.deepEqual(config.waker, { enabled: true, agents: [{ id: "x" }] });
  assert.throws(() =>
    parseConfig({
      version: 1,
      projects: {},
      attention: { continue_on_stop: ["pi"] }
    })
  );
  assert.throws(() => parseConfig({ version: 1, projects: {}, waker: [] }));
});

test("CLI parses attention flags, hook events and waker commands", () => {
  assert.deepEqual(
    parseInvocationArgs([
      "mcp",
      "--integration",
      "codex",
      "--wait-budget-seconds",
      "600"
    ]),
    { command: "mcp", integration: "codex", waitBudgetSeconds: 600 }
  );
  for (const bad of ["0", "-1", "1.5", "abc", "3601"])
    assert.throws(() =>
      parseInvocationArgs([
        "mcp",
        "--integration",
        "codex",
        "--wait-budget-seconds",
        bad
      ])
    );
  assert.throws(() =>
    parseInvocationArgs(["status", "--wait-budget-seconds", "5"])
  );
  assert.deepEqual(
    parseInvocationArgs(["hook", "claude-code", "--event", "Stop", "--watch"]),
    {
      command: "hook",
      integration: "claude-code",
      event: "Stop",
      watch: true
    }
  );
  assert.deepEqual(parseInvocationArgs(["hook", "codex", "--event", "Stop"]), {
    command: "hook",
    integration: "codex",
    event: "Stop"
  });
  assert.throws(() =>
    parseInvocationArgs(["hook", "opencode", "--event", "idle"])
  );
  assert.deepEqual(parseInvocationArgs(["hook", "cursor", "--event", "stop"]), {
    command: "hook",
    integration: "cursor",
    event: "stop"
  });
  assert.throws(() =>
    parseInvocationArgs(["hook", "codex", "--event", "Stop", "--watch"])
  );
  assert.throws(() =>
    parseInvocationArgs(["hook", "opencode", "--event", "Stop"])
  );
  assert.throws(() =>
    parseInvocationArgs(["hook", "claude-code", "--event", "SessionStart"])
  );
  assert.deepEqual(
    parseInvocationArgs(["setup", "--auto-continue", "--rewake"]),
    {
      command: "setup",
      autoContinue: true,
      rewake: true
    }
  );
  assert.throws(() => parseInvocationArgs(["setup", "--rewake"]));
  assert.throws(() => parseInvocationArgs(["status", "--auto-continue"]));
  assert.deepEqual(
    parseInvocationArgs(["waker", "run", "--once", "--dry-run"]),
    {
      command: "waker",
      wakerArgs: ["run", "--once", "--dry-run"]
    }
  );
  assert.throws(() => parseInvocationArgs(["waker", "start"]));
  assert.throws(() => parseInvocationArgs(["status", "--once"]));
});

// ORC-76: the top-level parser rejected these before waker.ts saw them.
test("CLI passes waker enable --integration and --wake-on through to the waker", () => {
  for (const wakerArgs of [
    ["enable", "--integration", "codex"],
    ["enable", "--wake-on", "handoff,direct_message,mention"],
    ["enable", "--integration", "claude-code", "--wake-on", "mention"],
    ["enable", "--integration=cursor", "--wake-on=direct_message"],
    [
      "enable",
      "--integration",
      "codex",
      "--integration",
      "antigravity",
      "--wake-on",
      "handoff",
      "--wake-on",
      "mention"
    ],
    // Values are validated by waker.ts, which names the bad one.
    ["enable", "--integration", "opencode"],
    ["enable", "--wake-on", "everything"]
  ])
    assert.deepEqual(parseInvocationArgs(["waker", ...wakerArgs]), {
      command: "waker",
      wakerArgs
    });
  assert.throws(() => parseInvocationArgs(["status", "--wake-on", "handoff"]));
  assert.throws(() =>
    parseInvocationArgs([
      "mcp",
      "--integration",
      "codex",
      "--wake-on",
      "handoff"
    ])
  );
  assert.throws(
    () => parseInvocationArgs(["waker", "enable", "--wake-on"]),
    /--wake-on <value>' argument missing/
  );
  assert.throws(
    () => parseInvocationArgs(["waker", "enable", "--integration"]),
    /--integration <value>' argument missing/
  );
  assert.throws(
    () => parseInvocationArgs(["status", "--integration", "codex"]),
    /Usage: .*waker enable \[--integration <integration>\]\.\.\. \[--wake-on/
  );
});

class Store implements CredentialStore {
  values = new Map<string, string>();
  async read(account: string) {
    return this.values.get(account);
  }
  async write(account: string, value: string) {
    this.values.set(account, value);
  }
  async remove(account: string) {
    this.values.delete(account);
  }
}
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });

test("setup --auto-continue --rewake writes managed entries idempotently and disconnect removes them", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-attention-setup-"));
  const cwd = join(home, "project");
  const sourceCommand = join(home, "cli", "dist", "main.js");
  await mkdir(join(home, "cli", "dist"), { recursive: true });
  await writeFile(sourceCommand, "#!/usr/bin/env node\n");
  await writeFile(join(home, "cli", "package.json"), '{"version":"0.1.0"}\n');
  await chmod(sourceCommand, 0o700);
  await mkdir(join(home, ".orchestrat"), { recursive: true });
  await writeFile(
    join(home, ".orchestrat", "config.json"),
    JSON.stringify({ version: 1, projects: {}, waker: { enabled: false } })
  );
  const store = new Store();
  store.values.set("cli:https://api.example", "orch_cli_" + "c".repeat(32));
  let agent = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/projects"))
      return response({
        projects: [
          {
            id: "550e8400-e29b-41d4-a716-446655440000",
            name: "Project",
            organization_name: "Org"
          }
        ]
      });
    agent += 1;
    return response({
      agent: { id: `550e8400-e29b-41d4-a716-44665544000${agent}` },
      credential: { token: `orch_agent_${agent}_${"x".repeat(20)}` }
    });
  };
  const integrations = [
    "codex",
    "claude-code",
    "cursor",
    "antigravity"
  ] as const;
  const setup = () =>
    runSetup({
      api: "https://api.example",
      fetch,
      open: async () => undefined,
      sleep: async () => undefined,
      store,
      cwd,
      home,
      integrations: [...integrations],
      sourceCommand,
      pathEnv: "/usr/bin",
      autoContinue: true,
      rewake: true
    });
  const result = await setup();
  assert.equal(result.notes?.length, 1);
  assert.match(result.notes![0]!, /\/hooks/);
  const config = await readConfig(home);
  assert.deepEqual(config.attention, {
    continue_on_stop: [...integrations],
    rewake: true
  });
  assert.deepEqual(config.waker, { enabled: false });
  const files = {
    claude: join(home, ".claude", "settings.json"),
    codexHooks: join(home, ".codex", "hooks.json"),
    codexMcp: join(home, ".codex", "config.toml"),
    cursor: join(home, ".cursor", "hooks.json"),
    antigravity: join(home, ".gemini", "config", "mcp_config.json")
  };
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(files).map(async ([key, path]) => [
          key,
          await readOptional(path)
        ])
      )
    );
  const first = await snapshot();
  assert.match(first.claude!, /--event Stop --watch/);
  assert.match(first.codexHooks!, /hook codex --event Stop/);
  assert.match(first.codexMcp!, /tool_timeout_sec = 660/);
  assert.match(first.cursor!, /"loop_limit": 2/);
  assert.match(first.antigravity!, /"timeoutSeconds": 660/);
  // A second run (flags or not) converges on the same files.
  await setup();
  assert.deepEqual(await snapshot(), first);
  await runSetup({
    api: "https://api.example",
    fetch,
    open: async () => undefined,
    sleep: async () => undefined,
    store,
    cwd,
    home,
    integrations: [...integrations],
    sourceCommand,
    pathEnv: "/usr/bin"
  });
  assert.deepEqual(await snapshot(), first);
  await disconnectLocal({
    home,
    cwd,
    integration: "all",
    store,
    api: "https://api.example",
    localOnly: true,
    sourceCommand
  });
  const after = await snapshot();
  for (const key of [
    "claude",
    "codexHooks",
    "codexMcp",
    "cursor",
    "antigravity"
  ])
    assert.doesNotMatch(after[key] ?? "", /orchestrat/, key);
  const remaining = JSON.parse(
    await readFile(join(home, ".orchestrat", "config.json"), "utf8")
  );
  assert.equal(remaining.attention?.continue_on_stop, undefined);
  assert.deepEqual(remaining.waker, { enabled: false });
});
