import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { findMapping, findProject, parseConfig } from "./config.js";
import { MemoryCredentialReader } from "./keychain.js";
import { parseInvocationArgs } from "./main.js";
import { resolveInvocation } from "./resolve.js";

const execFileAsync = promisify(execFile);

test("finds the nearest explicit project mapping", () => {
  const cwd = "/tmp/orchestrat-project/packages/app";
  const config = parseConfig({
    version: 1,
    projects: {
      "/tmp/orchestrat-project": {
        projectId: "project",
        integrations: { codex: { agentId: "agent" } }
      }
    }
  });
  assert.equal(
    findMapping(config, cwd, "codex")?.cwd,
    "/tmp/orchestrat-project"
  );
});

test("does not skip a nearer project without the selected integration", () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrat-cli-"));
  const nested = join(root, "packages", "app");
  mkdirSync(nested, { recursive: true });
  const config = parseConfig({
    version: 1,
    projects: {
      [root]: {
        projectId: "parent",
        integrations: { codex: { agentId: "parent-agent" } }
      },
      [join(root, "packages")]: { projectId: "near", integrations: {} }
    }
  });
  assert.equal(findProject(config, nested)?.projectId, "near");
  assert.equal(findMapping(config, nested, "codex"), undefined);
  rmSync(root, { recursive: true, force: true });
});

test("accepts only the two supported command shapes", () => {
  assert.deepEqual(parseInvocationArgs(["status"]), { command: "status" });
  assert.deepEqual(parseInvocationArgs(["disconnect", "all", "--local"]), {
    command: "disconnect",
    integration: "all",
    local: true
  });
  assert.throws(() => parseInvocationArgs(["status", "--local"]));
  assert.deepEqual(parseInvocationArgs(["mcp", "--integration", "codex"]), {
    command: "mcp",
    integration: "codex"
  });
  assert.throws(() => parseInvocationArgs(["status", "extra"]));
  assert.throws(() =>
    parseInvocationArgs(["mcp", "--integration", "codex", "--other"])
  );
});

test("accepts configurable harness commands and explicit hook events", () => {
  assert.deepEqual(parseInvocationArgs(["mcp", "--integration", "cursor"]), {
    command: "mcp",
    integration: "cursor"
  });
  assert.deepEqual(parseInvocationArgs(["disconnect", "antigravity"]), {
    command: "disconnect",
    integration: "antigravity",
    local: false
  });
  assert.deepEqual(
    parseInvocationArgs(["hook", "cursor", "--event", "sessionStart"]),
    {
      command: "hook",
      integration: "cursor",
      event: "sessionStart"
    }
  );
  assert.deepEqual(parseInvocationArgs(["hook", "cursor"]), {
    command: "hook",
    integration: "cursor",
    event: undefined
  });
  assert.throws(() => parseInvocationArgs(["hook", "antigravity"]));
  assert.throws(() => parseInvocationArgs(["hook", "opencode"]));
  assert.throws(() =>
    parseInvocationArgs(["hook", "antigravity", "--event", "other"])
  );
});

test("built CLI --version matches package metadata", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    new URL("./main.js", import.meta.url).pathname,
    "--version"
  ]);
  const metadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string };
  assert.equal(stdout.trim(), metadata.version);
});

test("built CLI runs when invoked through a symlink", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrat-cli-link-"));
  const link = join(root, "orchestrat");
  const { stdout: expected } = await execFileAsync(process.execPath, [
    new URL("./main.js", import.meta.url).pathname,
    "--version"
  ]);
  symlinkSync(new URL("./main.js", import.meta.url).pathname, link);
  const { stdout } = await execFileAsync(process.execPath, [link, "--version"]);
  assert.equal(stdout, expected);
  rmSync(root, { recursive: true, force: true });
});

test("preserves and validates an optional project API URL", () => {
  const config = parseConfig({
    version: 1,
    projects: {
      "/tmp/project": {
        projectId: "p",
        apiUrl: "http://localhost:3001/ignored",
        integrations: {}
      }
    }
  });
  assert.equal(config.projects["/tmp/project"].apiUrl, "http://localhost:3001");
  assert.throws(() =>
    parseConfig({
      version: 1,
      projects: {
        "/tmp/project": {
          projectId: "p",
          apiUrl: "file:///tmp",
          integrations: {}
        }
      }
    })
  );
});

test("resolves credentials without exposing them in the public result", async () => {
  const resolved = await resolveInvocation({
    cwd: "/tmp/project",
    integration: "codex",
    read: async () =>
      parseConfig({
        version: 1,
        projects: {
          "/tmp/project": {
            projectId: "p",
            integrations: { codex: { agentId: "a" } }
          }
        }
      }),
    credentials: new MemoryCredentialReader(new Map([["codex", "secret"]]))
  });
  assert.deepEqual(resolved.public, {
    configured: true,
    cwd: "/tmp/project",
    projectId: "p",
    integration: "codex",
    agentId: "a"
  });
  assert.equal("credential" in resolved.public, false);
});
