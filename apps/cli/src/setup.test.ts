import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfig } from "./config.js";
import type { CredentialStore } from "./keychain.js";
import { runSetup, type SetupPreview } from "./setup.js";
import { resolveInvocation } from "./resolve.js";

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

test("empty setup uses approved project, stores distinct credentials, and resolves mappings", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-setup-"));
  const cwd = join(home, "project");
  const store = new Store();
  const opened: string[] = [];
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/attempts"))
      return response(
        {
          attempt_id: "ca_test",
          secret: "s".repeat(40),
          expires_at: new Date(Date.now() + 60_000).toISOString()
        },
        201
      );
    if (url.endsWith("/poll"))
      return response({
        status: "approved",
        project_id: "550e8400-e29b-41d4-a716-446655440000",
        credential: "orch_cli_" + "c".repeat(32)
      });
    const integration = JSON.parse(String(init?.body)).integration;
    return response({
      agent: {
        id:
          integration === "codex"
            ? "550e8400-e29b-41d4-a716-446655440001"
            : "550e8400-e29b-41d4-a716-446655440002"
      },
      credential: { token: `orch_agent_${integration}_${"x".repeat(20)}` }
    });
  };
  const previews: SetupPreview[][] = [];
  const result = await runSetup({
    api: "https://api.example",
    fetch,
    open: async (url) => {
      opened.push(url);
    },
    sleep: async () => {},
    store,
    cwd,
    home,
    integrations: ["codex", "claude-code"],
    reportPreview: (value) => {
      previews.push(value);
    },
    sourceCommand: "/usr/local/bin/orchestrat"
  });
  const flattened = previews.flat();
  assert.equal(
    flattened.filter((preview) => preview.entries?.includes("launcher")).length,
    1
  );
  const entries = new Set(
    flattened.flatMap((preview) => preview.entries ?? [])
  );
  for (const entry of [
    "mcp_servers.orchestrat",
    "mcpServers.orchestrat",
    "SessionStart",
    "SessionEnd",
    "StopFailure"
  ]) {
    assert.ok(entries.has(entry), entry);
  }
  assert.doesNotMatch(
    JSON.stringify({ previews, result }),
    /orch_(?:cli|agent)_/
  );
  assert.equal(opened.length, 1);
  assert.equal(store.values.size, 3);
  const configText = await readFile(
    join(home, ".orchestrat", "config.json"),
    "utf8"
  );
  assert.doesNotMatch(configText, /orch_(?:cli|agent)_/);
  const config = await readConfig(home);
  for (const integration of ["codex", "claude-code"] as const) {
    const resolved = await resolveInvocation({
      cwd,
      integration,
      home,
      read: readConfig,
      credentials: store
    });
    assert.equal(
      (resolved.public as { integration: string }).integration,
      integration
    );
    assert.ok(resolved.credential);
  }
  assert.ok(calls.some((url) => url.endsWith("/attempts")));
  assert.equal(
    config.projects[cwd]?.projectId,
    "550e8400-e29b-41d4-a716-446655440000"
  );
});

test("stored CLI credential recovers project without opening browser", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-setup-"));
  const store = new Store();
  await store.write("cli", "orch_cli_" + "c".repeat(32));
  const opened: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) =>
    String(input).endsWith("/project")
      ? response({ project_id: "550e8400-e29b-41d4-a716-446655440000" })
      : response({
          agent: { id: "550e8400-e29b-41d4-a716-446655440001" },
          credential: { token: "orch_agent_" + "x".repeat(32) }
        });
  await runSetup({
    api: "https://api.example",
    fetch,
    open: async (url) => {
      opened.push(url);
    },
    sleep: async () => {},
    store,
    cwd: join(home, "project"),
    home,
    integrations: ["codex"],
    sourceCommand: "/usr/local/bin/orchestrat"
  });
  assert.equal(opened.length, 0);
});
