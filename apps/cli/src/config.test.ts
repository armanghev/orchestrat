import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findMapping, findProject, parseConfig } from "./config.js";
import { MemoryCredentialReader } from "./keychain.js";
import { parseInvocationArgs } from "./main.js";
import { resolveInvocation } from "./resolve.js";

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
  assert.deepEqual(parseInvocationArgs(["mcp", "--integration", "codex"]), {
    command: "mcp",
    integration: "codex"
  });
  assert.throws(() => parseInvocationArgs(["status", "extra"]));
  assert.throws(() =>
    parseInvocationArgs(["mcp", "--integration", "codex", "--other"])
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
