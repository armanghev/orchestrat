#!/bin/sh
set -eu

cli=${1-}
[ -n "$cli" ] && [ -x "$cli" ] || {
  echo "usage: $0 /absolute/path/to/orchestrat" >&2
  exit 64
}

version=$("$cli" --version)
[ "$version" = "0.1.0-alpha.1" ] || {
  echo "expected 0.1.0-alpha.1, got $version" >&2
  exit 1
}

bundle=$(node -e 'const fs=require("node:fs"); process.stdout.write(fs.realpathSync(process.argv[1]))' "$cli")
for tool in \
  list_projects select_project get_project list_tasks get_task create_task \
  update_task claim_task release_task complete_task list_task_comments \
  add_task_comment list_agents get_recent_activity heartbeat list_documents \
  read_document create_document update_document edit_document \
  list_document_revisions read_document_revision
do
  grep -Fq "\"$tool\"" "$bundle" || {
    echo "missing bundled MCP tool: $tool" >&2
    exit 1
  }
done

# The production executable intentionally reads credentials from Keychain, so
# artifact verification imports a disposable copy of the installed bundle and
# exposes only its already-bundled stdio bridge to a controlled fake transport.
# This exercises the packed MCP server without reading user config or Keychain.
scratch=$(mktemp -d "${TMPDIR:-/tmp}/orchestrat-cli-verify.XXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
ORCHESTRAT_ACCEPTANCE_CONFIG_ROOT=$scratch node --input-type=module - "$bundle" "$scratch" <<'NODE'
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const [bundle, root] = process.argv.slice(2);
const packageRoot = join(root, "package");
const copiedBundle = join(packageRoot, "dist", "main.js");
await mkdir(dirname(copiedBundle), { recursive: true });
let source = await readFile(bundle, "utf8");
source = source.replace(
  /export \{\s*main,\s*parseInvocationArgs\s*\};/,
  "export { main, parseInvocationArgs, startStdioBridge };"
);
assert.match(source, /export \{ main, parseInvocationArgs, startStdioBridge \};/);
await writeFile(copiedBundle, source);
await copyFile(join(dirname(dirname(bundle)), "package.json"), join(packageRoot, "package.json"));
await writeFile(
  join(root, "projects.json"),
  JSON.stringify({
    projects: [
      { id: "00000000-0000-4000-8000-000000000001", name: "Fixture / Alpha" }
    ]
  })
);

const runner = `
  import { startStdioBridge } from ${JSON.stringify(pathToFileURL(copiedBundle).href)};
  const id = "00000000-0000-4000-8000-000000000001";
  const client = {
    async openSession() { return { session: { id } }; },
    async closeSession() { return {}; },
    async heartbeat() { return {}; },
    async getProject() { return { id, name: "Alpha" }; }
  };
  await startStdioBridge({
    integration: "cursor",
    projects: [{ id, name: "Fixture / Alpha", client }]
  });
`;
const child = spawn(process.execPath, ["--input-type=module", "-e", runner], {
  stdio: ["pipe", "pipe", "pipe"]
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
let buffered = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf("\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});
let nextId = 0;
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}: ${stderr}`)), 5000);
  pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
});
try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "artifact-verifier", version: "1" }
  });
  assert.equal(initialized.result.serverInfo.name, "orchestrat");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await request("tools/list");
  const names = listed.result.tools.map((tool) => tool.name).sort();
  const expected = [
    "add_task_comment", "claim_task", "complete_task", "create_document",
    "create_task", "edit_document", "get_project", "get_recent_activity",
    "get_task", "heartbeat", "list_agents", "list_document_revisions",
    "list_documents", "list_projects", "list_task_comments", "list_tasks",
    "read_document", "read_document_revision", "release_task", "select_project",
    "update_document", "update_task"
  ].sort();
  assert.deepEqual(names, expected);
  const unselected = await request("tools/call", {
    name: "get_project", arguments: {}
  });
  const unselectedError = JSON.parse(unselected.result.content[0].text).error;
  assert.equal(unselected.result.isError, true);
  assert.equal(unselectedError.code, "AGENT_SESSION_NOT_FOUND");
  const selected = await request("tools/call", {
    name: "select_project", arguments: { project_id: "00000000-0000-4000-8000-000000000001" }
  });
  assert.equal(selected.result.isError, undefined);
  const project = await request("tools/call", { name: "get_project", arguments: {} });
  assert.equal(JSON.parse(project.result.content[0].text).id, "00000000-0000-4000-8000-000000000001");
} finally {
  child.kill("SIGTERM");
}
NODE

echo "CLI alpha verification passed: $version"
