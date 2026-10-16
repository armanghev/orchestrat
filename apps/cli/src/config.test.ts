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
import { resolveGlobalInvocation, resolveInvocation } from "./resolve.js";

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
  assert.deepEqual(
    parseInvocationArgs(["mcp", "--integration", "cursor", "--global"]),
    { command: "mcp", integration: "cursor", global: true }
  );
  assert.deepEqual(
    parseInvocationArgs(["mcp", "--integration", "codex", "--global"]),
    { command: "mcp", integration: "codex", global: true }
  );
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

test("accepts scriptable document commands and keeps attachment paths explicit", () => {
  assert.deepEqual(
    parseInvocationArgs([
      "documents",
      "list",
      "--integration",
      "codex",
      "--limit",
      "10"
    ]),
    {
      command: "document",
      integration: "codex",
      documentAction: "list",
      limit: 10
    }
  );
  assert.deepEqual(
    parseInvocationArgs([
      "documents",
      "list",
      "--integration",
      "codex",
      "--include-archived"
    ]),
    {
      command: "document",
      integration: "codex",
      documentAction: "list",
      includeArchived: true
    }
  );
  assert.deepEqual(
    parseInvocationArgs([
      "document",
      "create",
      "docs/readme.md",
      "--integration",
      "codex"
    ]),
    {
      command: "document",
      integration: "codex",
      documentAction: "create",
      path: "docs/readme.md"
    }
  );
  assert.deepEqual(
    parseInvocationArgs([
      "document",
      "patch",
      "doc-id",
      "--integration",
      "codex"
    ]),
    {
      command: "document",
      integration: "codex",
      documentAction: "patch",
      documentId: "doc-id"
    }
  );
  assert.deepEqual(
    parseInvocationArgs([
      "document",
      "download",
      "document-id",
      "attachment-id",
      "/tmp/out",
      "--integration",
      "codex"
    ]),
    {
      command: "document",
      integration: "codex",
      documentAction: "download",
      documentId: "document-id",
      attachmentId: "attachment-id",
      path: "/tmp/out"
    }
  );
  assert.throws(() => parseInvocationArgs(["document", "read", "doc-id"]));
  assert.throws(() =>
    parseInvocationArgs([
      "document",
      "read",
      "doc-id",
      "--limit",
      "5",
      "--integration",
      "codex"
    ])
  );
  assert.throws(() =>
    parseInvocationArgs([
      "document",
      "upload",
      "doc-id",
      "file.bin",
      "--cursor",
      "x",
      "--integration",
      "codex"
    ])
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
        apiUrl: "http://localhost:8801/ignored",
        integrations: {}
      }
    }
  });
  assert.equal(config.projects["/tmp/project"].apiUrl, "http://localhost:8801");
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
            apiUrl: "http://localhost:8801",
            integrations: { codex: { agentId: "a" } }
          }
        }
      }),
    credentials: new MemoryCredentialReader(
      new Map([["agent:p:codex:http://localhost:8801", "secret"]])
    )
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

test("resolves only the configured global Cursor projects", async () => {
  const projects = await resolveGlobalInvocation({
    integration: "cursor",
    read: async () =>
      parseConfig({
        version: 1,
        projects: {},
        globalProjects: {
          cursor: {
            "550e8400-e29b-41d4-a716-446655440000": {
              name: "Project",
              organizationName: "Org",
              apiUrl: "http://localhost:8801",
              agentId: "agent"
            }
          }
        }
      }),
    credentials: new MemoryCredentialReader(
      new Map([
        [
          "agent:550e8400-e29b-41d4-a716-446655440000:cursor:http://localhost:8801",
          "secret"
        ]
      ])
    )
  });
  assert.deepEqual(
    projects.map(({ projectId }) => projectId),
    ["550e8400-e29b-41d4-a716-446655440000"]
  );
});

test("configs that still name the retired OpenCode integration load without it", () => {
  const config = parseConfig({
    version: 1,
    projects: {
      "/work": {
        projectId: "p",
        apiUrl: "https://api.test",
        mcpScopes: { codex: "global", opencode: "global" },
        integrations: {
          codex: { agentId: "a" },
          opencode: { agentId: "b" }
        }
      }
    },
    globalProjects: {
      opencode: {
        p: { name: "Project", organizationName: "Org", agentId: "b" }
      }
    },
    attention: { continue_on_stop: ["codex", "opencode"] }
  });
  assert.deepEqual(Object.keys(config.projects["/work"]!.integrations), [
    "codex"
  ]);
  assert.deepEqual(config.projects["/work"]!.mcpScopes, { codex: "global" });
  assert.equal(config.globalProjects, undefined);
  assert.deepEqual(config.attention?.continue_on_stop, ["codex"]);
});
