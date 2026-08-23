import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  chmod,
  stat,
  symlink,
  writeFile,
  readlink,
  lstat,
  rm
} from "node:fs/promises";
import { join } from "node:path";
import { disconnectLocal, runDoctor, runStatus } from "./diagnostics.js";
import { mergeHooks, mergeJson, mergeToml } from "./safe-files.js";
import { configPath } from "./config.js";

class Store {
  values = new Map<string, string>();
  writes = 0;
  async read(account: string) {
    return this.values.get(account);
  }
  async write(account: string, value: string) {
    this.writes++;
    this.values.set(account, value);
  }
  async remove(account: string) {
    this.values.delete(account);
  }
}

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function setupHome() {
  const home = await mkdtemp(join("/tmp", "orchestrat-diagnostics-"));
  const project = join(home, "project");
  await mkdir(join(home, ".orchestrat"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
  const command = join(home, ".local", "bin", "orchestrat");
  const source = join(home, "source");
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await writeFile(source, "#!/bin/sh\n");
  await chmod(source, 0o700);
  await symlink(source, command);
  const codexMcp = `${mergeToml(undefined, "codex", command)}[mcp_servers.unrelated]\ncommand = "keep"\n`;
  const codexHooks = mergeHooks(
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: "other",
            hooks: [{ type: "command", command: "echo keep" }]
          }
        ]
      }
    }),
    "codex",
    command
  );
  const claudeMcp = mergeJson(undefined, "claude-code", command);
  const claudeHooks = mergeHooks(undefined, "claude-code", command);
  await writeFile(join(home, ".codex", "config.toml"), codexMcp);
  await writeFile(join(home, ".codex", "hooks.json"), codexHooks);
  await writeFile(join(home, ".claude.json"), claudeMcp);
  await writeFile(join(home, ".claude", "settings.json"), claudeHooks);
  const backupPath = join(home, ".codex", "config.toml.orchestrat-backup");
  await writeFile(backupPath, "backup sentinel\n");
  await writeFile(
    configPath(home),
    JSON.stringify({
      version: 1,
      projects: {
        [project]: {
          projectId: id(1),
          integrations: {
            codex: { agentId: id(2) },
            "claude-code": { agentId: id(3) }
          }
        }
      }
    })
  );
  const store = new Store();
  store.values.set("cli", `orch_cli_${"x".repeat(32)}`);
  store.values.set("agent:codex", `orch_agent_${"c".repeat(32)}`);
  store.values.set("agent:claude-code", `orch_agent_${"a".repeat(32)}`);
  return { home, project, command, source, store, backupPath };
}

test("disconnect partial removes only selected exact entries and preserves backups", async () => {
  const fixture = await setupHome();
  try {
    const calls: RequestInit[] = [];
    const backupBefore = await readFile(fixture.backupPath);
    const backupMtime = (await stat(fixture.backupPath)).mtimeMs;
    const result = await disconnectLocal({
      home: fixture.home,
      cwd: fixture.project,
      integration: "codex",
      store: fixture.store,
      api: "https://api.test",
      sourceCommand: fixture.source,
      fetch: async (_url, init) => {
        calls.push(init ?? {});
        return new Response("{}", { status: 200 });
      }
    });
    assert.deepEqual(result.disconnected, ["codex"]);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(String(calls[0]!.body)), {
      project_id: id(1),
      agent_ids: [id(2)],
      revoke_cli: false
    });
    assert.equal(
      JSON.parse(await readFile(configPath(fixture.home), "utf8")).projects[
        fixture.project
      ].integrations["claude-code"].agentId,
      id(3)
    );
    assert.equal(fixture.store.values.has("agent:codex"), false);
    assert.equal(fixture.store.values.has("agent:claude-code"), true);
    assert.equal(
      (
        await lstat(join(fixture.home, ".local", "bin", "orchestrat"))
      ).isSymbolicLink(),
      true
    );
    assert.doesNotMatch(
      await readFile(join(fixture.home, ".codex", "config.toml"), "utf8"),
      /mcp_servers\.orchestrat/
    );
    assert.match(
      await readFile(join(fixture.home, ".codex", "config.toml"), "utf8"),
      /mcp_servers\.unrelated/
    );
    assert.match(
      await readFile(join(fixture.home, ".codex", "hooks.json"), "utf8"),
      /echo keep/
    );
    assert.deepEqual(await readFile(fixture.backupPath), backupBefore);
    assert.equal((await stat(fixture.backupPath)).mtimeMs, backupMtime);
    assert.match(
      await readFile(join(fixture.home, ".claude.json"), "utf8"),
      /orchestrat/
    );
    assert.doesNotMatch(
      await readFile(join(fixture.home, ".codex", "hooks.json"), "utf8"),
      /hook codex/
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("disconnect backend failure and missing CLI token mutate nothing", async () => {
  const fixture = await setupHome();
  try {
    const paths = [
      configPath(fixture.home),
      join(fixture.home, ".codex", "config.toml"),
      join(fixture.home, ".codex", "hooks.json"),
      join(fixture.home, ".claude.json"),
      join(fixture.home, ".claude", "settings.json")
    ];
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const linkBefore = await readlink(
      join(fixture.home, ".local", "bin", "orchestrat")
    );
    const storeBefore = new Map(fixture.store.values);
    await assert.rejects(() =>
      disconnectLocal({
        home: fixture.home,
        cwd: fixture.project,
        integration: "codex",
        store: fixture.store,
        api: "https://api.test",
        sourceCommand: fixture.source,
        fetch: async () => new Response("{}", { status: 500 })
      })
    );
    assert.deepEqual(
      await Promise.all(paths.map((path) => readFile(path))),
      before
    );
    assert.equal(
      await readlink(join(fixture.home, ".local", "bin", "orchestrat")),
      linkBefore
    );
    assert.deepEqual(fixture.store.values, storeBefore);
    await rm(fixture.home, { recursive: true, force: true });
    const missing = await setupHome();
    missing.store.values.delete("cli");
    const missingPaths = [
      configPath(missing.home),
      join(missing.home, ".codex", "config.toml"),
      join(missing.home, ".codex", "hooks.json"),
      join(missing.home, ".claude.json"),
      join(missing.home, ".claude", "settings.json")
    ];
    const missingBefore = await Promise.all(
      missingPaths.map((path) => readFile(path))
    );
    const missingLink = await readlink(
      join(missing.home, ".local", "bin", "orchestrat")
    );
    await assert.rejects(() =>
      disconnectLocal({
        home: missing.home,
        cwd: missing.project,
        integration: "codex",
        store: missing.store,
        api: "https://api.test",
        sourceCommand: missing.source,
        fetch: async () => new Response("{}", { status: 200 })
      })
    );
    assert.deepEqual(
      await Promise.all(missingPaths.map((path) => readFile(path))),
      missingBefore
    );
    assert.equal(
      await readlink(join(missing.home, ".local", "bin", "orchestrat")),
      missingLink
    );
    assert.deepEqual(
      missing.store.values,
      new Map([
        ["agent:codex", `orch_agent_${"c".repeat(32)}`],
        ["agent:claude-code", `orch_agent_${"a".repeat(32)}`]
      ])
    );
    await rm(missing.home, { recursive: true, force: true });
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("shared integration keeps provider files and keychain credential", async () => {
  const fixture = await setupHome();
  try {
    const config = JSON.parse(await readFile(configPath(fixture.home), "utf8"));
    config.projects[join(fixture.home, "other")] = {
      projectId: id(5),
      integrations: { codex: { agentId: id(6) } }
    };
    await writeFile(configPath(fixture.home), JSON.stringify(config));
    const before = await readFile(
      join(fixture.home, ".codex", "config.toml"),
      "utf8"
    );
    await disconnectLocal({
      home: fixture.home,
      cwd: fixture.project,
      integration: "codex",
      store: fixture.store,
      api: "https://api.test",
      sourceCommand: fixture.source,
      fetch: async () => new Response("{}", { status: 200 })
    });
    assert.equal(
      await readFile(join(fixture.home, ".codex", "config.toml"), "utf8"),
      before
    );
    assert.equal(fixture.store.values.has("agent:codex"), true);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("final disconnect removes managed entries, launcher, and credentials", async () => {
  const fixture = await setupHome();
  try {
    const result = await disconnectLocal({
      home: fixture.home,
      cwd: fixture.project,
      integration: "all",
      store: fixture.store,
      api: "https://api.test",
      sourceCommand: fixture.source,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.revoke_cli, true);
        return new Response("{}", { status: 200 });
      }
    });
    assert.equal(result.disconnected.length, 2);
    await assert.rejects(() =>
      lstat(join(fixture.home, ".local", "bin", "orchestrat"))
    );
    assert.equal(fixture.store.values.size, 0);
    assert.doesNotMatch(
      await readFile(join(fixture.home, ".claude.json"), "utf8"),
      /orchestrat/
    );
    assert.doesNotMatch(
      await readFile(join(fixture.home, ".codex", "config.toml"), "utf8"),
      /mcp_servers\.orchestrat/
    );
    assert.doesNotMatch(
      await readFile(join(fixture.home, ".codex", "hooks.json"), "utf8"),
      /hook codex/
    );
    assert.doesNotMatch(
      await readFile(join(fixture.home, ".claude", "settings.json"), "utf8"),
      /hook claude-code/
    );
    assert.equal(
      JSON.parse(await readFile(configPath(fixture.home), "utf8")).projects[
        fixture.project
      ],
      undefined
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("status and doctor redact credentials and report partial backend failure", async () => {
  const fixture = await setupHome();
  try {
    let presenceCalls = 0;
    const fetch = async (url: RequestInfo | URL) =>
      String(url).includes("presence") && presenceCalls++ >= 1
        ? new Response("{}", { status: 500 })
        : String(url).includes("presence")
          ? new Response(
              JSON.stringify({
                agents: [
                  {
                    agent_id: id(2),
                    project_id: id(1),
                    session_id: id(4),
                    status: "online",
                    last_heartbeat_at: "2026-08-22T00:00:00.000Z",
                    current_task_id: null
                  },
                  {
                    agent_id: id(3),
                    project_id: id(1),
                    session_id: id(4),
                    status: "online",
                    last_heartbeat_at: "2026-08-22T00:00:00.000Z",
                    current_task_id: null
                  },
                  {
                    agent_id: id(3),
                    project_id: id(1),
                    session_id: id(4),
                    status: "online",
                    last_heartbeat_at: "2026-08-22T00:00:00.000Z",
                    current_task_id: null
                  },
                  {
                    agent_id: id(3),
                    project_id: id(1),
                    session_id: id(4),
                    status: "online",
                    last_heartbeat_at: "2026-08-22T00:00:00.000Z",
                    current_task_id: null
                  }
                ]
              })
            )
          : new Response(JSON.stringify({ project_id: id(1) }));
    const status = await runStatus({
      home: fixture.home,
      cwd: fixture.project,
      credentials: fixture.store,
      api: "https://api.test",
      fetch
    });
    const doctor = await runDoctor({
      home: fixture.home,
      cwd: fixture.project,
      credentials: fixture.store,
      api: "https://api.test",
      sourceCommand: fixture.source,
      fetch
    });
    const healthy = await runDoctor({
      home: fixture.home,
      cwd: fixture.project,
      credentials: fixture.store,
      api: "https://api.test",
      sourceCommand: fixture.source,
      fetch: async (url) =>
        String(url).includes("presence")
          ? new Response(
              JSON.stringify({
                agents: [
                  {
                    agent_id: id(2),
                    project_id: id(1),
                    session_id: id(4),
                    status: "online",
                    last_heartbeat_at: "2026-08-22T00:00:00.000Z",
                    current_task_id: null
                  },
                  {
                    agent_id: id(3),
                    project_id: id(1),
                    session_id: id(4),
                    status: "online",
                    last_heartbeat_at: "2026-08-22T00:00:00.000Z",
                    current_task_id: null
                  }
                ]
              })
            )
          : new Response(JSON.stringify({ project_id: id(1) }))
    });
    assert.equal(healthy.checks.mapping?.ok, true);
    assert.equal(healthy.checks["credential.codex"]?.ok, true);
    assert.equal(healthy.checks["credential.claude-code"]?.ok, true);
    assert.equal(healthy.checks["backend.codex"]?.ok, true);
    assert.equal(healthy.checks["backend.claude-code"]?.ok, true);
    assert.equal(healthy.checks.launcher?.ok, true);
    assert.equal((status.backend.codex as { status: string }).status, "online");
    assert.equal(
      Object.values(status.backend).some(
        (value) =>
          (value as { ok?: boolean; reachable?: boolean }).ok === false ||
          (value as { reachable?: boolean }).reachable === false
      ),
      true
    );
    assert.equal(doctor.checks.launcher?.ok, true);
    assert.doesNotMatch(
      JSON.stringify({ status, doctor }),
      /orch_(?:cli|agent)_/
    );
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("doctor distinguishes malformed, outdated, and missing local prerequisites", async () => {
  const fixture = await setupHome();
  try {
    await writeFile(configPath(fixture.home), "not json");
    const malformed = await runDoctor({
      home: fixture.home,
      cwd: fixture.project,
      credentials: fixture.store,
      api: "https://api.test",
      sourceCommand: fixture.source,
      fetch: async () => new Response("{}")
    });
    assert.equal(malformed.checks.config?.ok, false);
    await rm(fixture.home, { recursive: true, force: true });
    const second = await setupHome();
    await writeFile(
      join(second.home, ".codex", "config.toml"),
      '[mcp_servers.unrelated]\ncommand = "keep"\n'
    );
    const outdated = await runDoctor({
      home: second.home,
      cwd: second.project,
      credentials: second.store,
      api: "https://api.test",
      sourceCommand: second.source,
      fetch: async () => new Response(JSON.stringify({ agents: [] }))
    });
    assert.equal(outdated.checks["config.codex"]?.ok, false);
    await rm(join(second.home, ".local", "bin", "orchestrat"));
    const missing = await runDoctor({
      home: second.home,
      cwd: second.project,
      credentials: second.store,
      api: "https://api.test",
      sourceCommand: second.source,
      fetch: async () => new Response(JSON.stringify({ agents: [] }))
    });
    assert.equal(missing.checks.launcher?.ok, false);
    await rm(second.home, { recursive: true, force: true });
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});
