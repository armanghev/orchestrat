import assert from "node:assert/strict";
import test from "node:test";
import {
  isInteractive,
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
  renderResult("doctor", { checks: { config: { ok: true, detail: "valid" } } }, {
    interactive: false,
    write: (text) => output.push(text)
  });
  assert.equal(output[0], '{"checks":{"config":{"ok":true,"detail":"valid"}}}\n');
});

test("interactive doctor output contains only check details", () => {
  const output: string[] = [];
  renderDoctor({ checks: { credential: { ok: true, detail: "present" } } }, (text) => output.push(text));
  assert.match(output.join(""), /credential: present/);
  assert.doesNotMatch(output.join(""), /token|secret|orch_agent_/i);
});

test("setup progress runs and returns the operation result", async () => {
  const result = await runSetupProgress(async () => 42, { interactive: false });
  assert.equal(result, 42);
});

test("TTY detection requires both streams and excludes CI", () => {
  assert.equal(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} }), true);
  assert.equal(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: false }, env: {} }), false);
  assert.equal(isInteractive({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: { CI: "1" } }), false);
});
