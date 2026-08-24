import assert from "node:assert/strict";
import test from "node:test";
import { detectHarnesses, detectIntegrations } from "./setup.js";

test("detects configurable harnesses and keeps Pi out of setup", async () => {
  const found = await detectHarnesses(async (command) =>
    ["codex", "pi"].includes(command)
  );
  assert.deepEqual(found.map((item) => item.id), ["codex", "pi"]);
  assert.deepEqual(
    await detectIntegrations(async (command) => ["codex", "pi"].includes(command)),
    ["codex"]
  );
});

test("Cursor uses cursor-agent then agent fallback", async () => {
  const commands: string[] = [];
  await detectHarnesses(async (command) => {
    commands.push(command);
    return command === "agent";
  });
  assert.deepEqual(commands.slice(0, 4), ["codex", "claude", "cursor-agent", "agent"]);
});
