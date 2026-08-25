import assert from "node:assert/strict";
import test from "node:test";
import {
  isInteractive,
  startSetup,
  renderDetectedAgents,
  renderSetupAuthorization,
  renderSetupResult,
  renderDoctor,
  renderResult,
  runSetupProgress,
  selectHarnesses
} from "./ui.js";

const harnesses = [
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" }
] as const;

test("selects all harnesses by default and maps selected IDs", async () => {
  let initial: string[] | undefined;
  const result = await selectHarnesses(harnesses, {
    interactive: true,
    components: {
      multiselect: async (options) => {
        initial = options.initialValues;
        return ["claude-code"];
      },
      cancel: () => undefined,
      outro: () => undefined,
      intro: () => undefined,
      log: {
        info: () => undefined,
        success: () => undefined,
        warn: () => undefined
      },
      note: () => undefined,
      spinner: () => ({ start: () => undefined, stop: () => undefined })
    }
  });
  assert.deepEqual(initial, ["codex", "claude-code"]);
  assert.deepEqual(result, { cancelled: false, values: [harnesses[1]] });
});

test("cancellation is distinct and does not select or mutate", async () => {
  let canceled = false;
  const result = await selectHarnesses(harnesses, {
    interactive: true,
    isCancel: (answer) => typeof answer === "symbol",
    components: {
      multiselect: async () => Symbol("cancel"),
      cancel: () => {
        canceled = true;
      },
      outro: () => undefined,
      intro: () => undefined,
      log: {
        info: () => undefined,
        success: () => undefined,
        warn: () => undefined
      },
      note: () => undefined,
      spinner: () => ({ start: () => undefined, stop: () => undefined })
    }
  });
  assert.deepEqual(result, { cancelled: true });
  assert.equal(canceled, true);
});

test("non-TTY selects without prompting and emits stable JSON", async () => {
  assert.deepEqual(await selectHarnesses(harnesses, { interactive: false }), {
    cancelled: false,
    values: [...harnesses]
  });
  const output: string[] = [];
  renderResult(
    "doctor",
    { checks: { config: { ok: true, detail: "valid" } } },
    {
      interactive: false,
      write: (text) => output.push(text)
    }
  );
  assert.equal(
    output[0],
    '{"checks":{"config":{"ok":true,"detail":"valid"}}}\n'
  );
});

test("interactive doctor output contains only check details", () => {
  const output: string[] = [];
  renderDoctor(
    { checks: { credential: { ok: true, detail: "present" } } },
    (text) => output.push(text)
  );
  assert.match(output.join(""), /credential: present/);
  assert.doesNotMatch(output.join(""), /token|secret|orch_agent_/i);
});

test("detected rendering separates configurable and unsupported agents", () => {
  const calls: string[] = [];
  renderDetectedAgents(
    [
      { id: "codex", label: "Codex", configurable: true },
      {
        id: "cursor",
        label: "Cursor",
        configurable: false,
        unsupportedReason: "not installed"
      }
    ],
    {
      interactive: true,
      write: () => undefined,
      components: {
        multiselect: async () => [],
        cancel: () => undefined,
        outro: () => undefined,
        intro: (message) => calls.push(`intro:${message}`),
        log: {
          info: (message) => calls.push(`info:${message}`),
          success: () => undefined,
          warn: () => undefined
        },
        note: (message, title) => calls.push(`note:${title}:${message}`),
        spinner: () => ({ start: () => undefined, stop: () => undefined })
      }
    }
  );
  assert.deepEqual(calls, [
    "info:Detected agents",
    "note:codex:Codex — configurable",
    "note:cursor:Cursor — unsupported: not installed"
  ]);
});

test("setup renders authorization before detected agents", () => {
  const calls: string[] = [];
  const components = {
    multiselect: async () => [],
    cancel: () => undefined,
    outro: () => undefined,
    intro: (message?: string) => calls.push(`intro:${message}`),
    log: {
      info: (message: string) => calls.push(`info:${message}`),
      success: (message: string) => calls.push(`success:${message}`),
      warn: () => undefined
    },
    note: () => undefined,
    spinner: () => ({ start: () => undefined, stop: () => undefined })
  };
  startSetup({ interactive: true, components });
  renderSetupAuthorization(
    { id: "project-123", name: "Project", organization_name: "Org" },
    { interactive: true, components }
  );
  renderDetectedAgents([], { interactive: true, write: () => undefined, components });
  assert.deepEqual(calls, [
    "intro:Welcome to Orchestrat",
    "success:Authenticated",
    "success:Selected project: Org / Project",
    "info:Detected agents"
  ]);
});

test("setup result reports MCP, hooks support, and connected count", () => {
  const output: string[] = [];
  renderSetupResult(
    {
      integrations: { codex: { agentId: "private" } },
      harnesses: [
        { id: "codex", mcpConfigured: true, hooksConfigured: true },
        { id: "cursor", hooksSupported: false }
      ]
    },
    (text) => output.push(text)
  );
  const rendered = output.join("");
  assert.match(rendered, /MCP configured/);
  assert.match(rendered, /Hooks: unavailable\/unsupported/);
  assert.match(rendered, /1 agents connected/);
  assert.doesNotMatch(rendered, /private/);
});

test("setup progress runs and returns the operation result", async () => {
  const result = await runSetupProgress(async () => 42, { interactive: false });
  assert.equal(result, 42);
});

test("TTY detection requires both streams and excludes CI", () => {
  assert.equal(
    isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} }),
    true
  );
  assert.equal(
    isInteractive({
      stdin: { isTTY: true },
      stdout: { isTTY: false },
      env: {}
    }),
    false
  );
  assert.equal(
    isInteractive({
      stdin: { isTTY: true },
      stdout: { isTTY: true },
      env: { CI: "1" }
    }),
    false
  );
});
