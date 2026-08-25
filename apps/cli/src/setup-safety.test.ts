import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  stat,
  mkdir,
  writeFile,
  readlink,
  symlink
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { atomicWrite } from "./safe-files.js";
import { detectIntegrations, installLauncher, runSetup } from "./setup.js";
import type { CredentialStore } from "./keychain.js";

const execFileAsync = promisify(execFile);

class Store implements CredentialStore {
  values = new Map<string, string>();
  writes = 0;
  async read(a: string) {
    return this.values.get(a);
  }
  async write(a: string, v: string) {
    this.writes++;
    this.values.set(a, v);
  }
  async remove(a: string) {
    this.values.delete(a);
  }
}
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status });
test("second setup is a no-op and malformed settings fails before transport", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-safe-"));
  const sourceCommand = join(home, "cli", "dist", "main.js");
  await mkdir(join(home, "cli", "dist"), { recursive: true });
  await writeFile(sourceCommand, "#!/usr/bin/env node\n");
  await writeFile(join(home, "cli", "package.json"), '{"version":"0.1.0"}\n');
  await chmod(sourceCommand, 0o700);
  const cwd = join(home, "project");
  const store = new Store();
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), 'model = "keep"\n');
  await writeFile(
    join(home, ".codex", "hooks.json"),
    '{"hooks":{"Other":[{"hooks":[{"type":"command","command":"echo keep"}]}]}}\n'
  );
  await writeFile(
    join(home, ".claude.json"),
    '{"mcpServers":{"other":{"command":"keep"}}}\n'
  );
  await writeFile(
    join(home, ".claude", "settings.json"),
    '{"hooks":{"Other":[{"hooks":[{"type":"command","command":"echo keep"}]}]}}\n'
  );
  let calls = 0;
  let opens = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    calls++;
    const url = String(input);
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
    return response({
      agent: { id: randomUUID() },
      credential: { token: "orch_agent_" + "x".repeat(32) }
    });
  };
  const options = {
    api: "https://api.example",
    fetch,
    open: async () => {
      opens++;
    },
    sleep: async () => {},
    store,
    cwd,
    home,
    integrations: ["codex", "claude-code"] as ("codex" | "claude-code")[],
    sourceCommand
  };
  await runSetup(options);
  const managed = [
    join(home, ".orchestrat", "config.json"),
    join(home, ".codex", "config.toml"),
    join(home, ".codex", "hooks.json"),
    join(home, ".claude.json"),
    join(home, ".claude", "settings.json")
  ];
  const snapshot = async () =>
    Promise.all(
      managed.map(async (path) => {
        const info = await stat(path);
        return { path, bytes: await readFile(path), mtimeMs: info.mtimeMs };
      })
    );
  const snapshots = await snapshot();
  const backupSnapshots = await Promise.all(
    (await readdir(home, { recursive: true }))
      .filter((path) => String(path).endsWith(".orchestrat-backup"))
      .map(async (path) => {
        const full = join(home, String(path));
        const info = await stat(full);
        return [full, info.mtimeMs, await readFile(full)] as const;
      })
  );
  const firstCalls = calls;
  const firstWrites = store.writes;
  await runSetup({
    ...options,
    sourceCommand: join(home, ".local", "bin", "orchestrat")
  });
  assert.equal(calls, firstCalls + 1);
  assert.equal(store.writes, firstWrites);
  assert.equal(opens, 1);
  for (const item of snapshots) {
    assert.deepEqual(await readFile(item.path), item.bytes);
    assert.equal((await stat(item.path)).mtimeMs, item.mtimeMs);
  }
  assert.equal(
    (await readdir(home, { recursive: true })).filter((path) =>
      String(path).endsWith(".orchestrat-backup")
    ).length,
    backupSnapshots.length
  );
  for (const [path, mtime, content] of backupSnapshots) {
    assert.equal((await stat(path)).mtimeMs, mtime);
    assert.deepEqual(await readFile(path), content);
  }
  assert.match(
    (await readFile(join(home, ".codex", "config.toml"))).toString(),
    /model = "keep"/
  );
  assert.match(
    (await readFile(join(home, ".claude.json"))).toString(),
    /"other"/
  );
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude", "settings.json"), "{bad");
  const malformedSnapshots = await snapshot();
  const malformedBackups = await Promise.all(
    (await readdir(home, { recursive: true }))
      .filter((path) => String(path).endsWith(".orchestrat-backup"))
      .map(async (path) => {
        const full = join(home, String(path));
        const info = await stat(full);
        return {
          path: full,
          bytes: await readFile(full),
          mtimeMs: info.mtimeMs
        };
      })
  );
  const backupPathsBeforeMalformed = (await readdir(home, { recursive: true }))
    .map(String)
    .filter((path) => path.endsWith(".orchestrat-backup"))
    .sort();
  const malformedWrites = store.writes;
  const malformedCalls = calls;
  const malformedOpens = opens;
  const malformedValues = new Map(store.values);
  await assert.rejects(() =>
    runSetup({ ...options, cwd: join(home, "other") })
  );
  assert.equal(calls, malformedCalls);
  assert.equal(store.writes, malformedWrites);
  assert.equal(opens, malformedOpens);
  assert.deepEqual(new Map(store.values), malformedValues);
  for (const item of malformedSnapshots) {
    assert.deepEqual(await readFile(item.path), item.bytes);
    assert.equal((await stat(item.path)).mtimeMs, item.mtimeMs);
  }
  for (const item of malformedBackups) {
    assert.deepEqual(await readFile(item.path), item.bytes);
    assert.equal((await stat(item.path)).mtimeMs, item.mtimeMs);
  }
  const backupPathsAfterMalformed = (await readdir(home, { recursive: true }))
    .map(String)
    .filter((path) => path.endsWith(".orchestrat-backup"))
    .sort();
  assert.deepEqual(backupPathsAfterMalformed, backupPathsBeforeMalformed);
});
test("atomic write preserves original after injected post-backup failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-safe-"));
  const path = join(home, "config");
  await atomicWrite(path, "original");
  await assert.rejects(() =>
    atomicWrite(path, "changed", true, () => {
      throw new Error("injected");
    })
  );
  assert.equal(await readFile(path, "utf8"), "original");
});

test("persistent launcher is an atomic managed runtime and rejects conflicts", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-launcher-"));
  const source = join(home, "cli-entry.js");
  await writeFile(source, "#!/usr/bin/env node\n");
  await writeFile(join(home, "package.json"), '{"version":"0.1.0"}\n');
  await chmod(source, 0o700);
  const target = await installLauncher(home, source);
  const firstRuntime = await readlink(target);
  assert.match(firstRuntime, /\.orchestrat\/runtimes\/runtime-/);
  await execFileAsync(target);
  const before = await stat(target);
  const beforeLink = await readlink(target);
  await assert.rejects(() =>
    installLauncher(home, join(home, "missing", "dist", "main.js"))
  );
  assert.equal(await readlink(target), beforeLink);
  assert.equal(await installLauncher(home, source), target);
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
  await writeFile(source, "#!/usr/bin/env node\nchanged\n");
  const changedRuntime = await installLauncher(home, source);
  assert.notEqual(await readlink(changedRuntime), firstRuntime);
  const currentRuntime = await readlink(target);
  await writeFile(
    join(dirname(dirname(currentRuntime)), "source.txt"),
    `${source}\n`
  );
  const refreshedRuntime = await installLauncher(home, source);
  assert.notEqual(await readlink(refreshedRuntime), currentRuntime);
  const upgraded = join(home, "next", "cli-entry.js");
  await mkdir(join(home, "next"), { recursive: true });
  await writeFile(upgraded, "#!/usr/bin/env node\n");
  await writeFile(join(home, "next", "package.json"), '{"version":"0.1.0"}\n');
  await chmod(upgraded, 0o700);
  await installLauncher(home, upgraded);
  assert.notEqual(await readlink(target), firstRuntime);
  await assert.rejects(() => stat(firstRuntime));
  const conflictHome = await mkdtemp(join(tmpdir(), "orch-launcher-conflict-"));
  await mkdir(join(conflictHome, ".local", "bin"), { recursive: true });
  await writeFile(
    join(conflictHome, ".local", "bin", "orchestrat"),
    "conflict"
  );
  await assert.rejects(
    () => installLauncher(conflictHome, source),
    /conflicts/
  );
  const danglingHome = await mkdtemp(join(tmpdir(), "orch-launcher-dangling-"));
  const danglingTarget = join(danglingHome, ".local", "bin", "orchestrat");
  await mkdir(join(danglingHome, ".local", "bin"), { recursive: true });
  await symlink(join(danglingHome, "missing"), danglingTarget);
  const danglingLink = await readlink(danglingTarget);
  await assert.rejects(() => installLauncher(danglingHome, source), /ENOENT/);
  assert.equal(await readlink(danglingTarget), danglingLink);
});

test("detects both, one, or no supported integrations", async () => {
  assert.deepEqual(await detectIntegrations(async () => true), [
    "codex",
    "claude-code",
    "cursor",
    "antigravity",
    "opencode"
  ]);
  assert.deepEqual(
    await detectIntegrations(async (command) => command === "codex"),
    ["codex"]
  );
  await assert.rejects(
    () => detectIntegrations(async () => false),
    /No supported agent integrations/
  );
});
