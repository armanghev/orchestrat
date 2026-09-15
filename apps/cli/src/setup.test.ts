import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
  const sourceCommand = join(home, "cli", "dist", "main.js");
  await mkdir(join(home, "cli", "dist"), { recursive: true });
  await writeFile(sourceCommand, "#!/usr/bin/env node\n");
  await writeFile(join(home, "cli", "package.json"), '{"version":"0.1.0"}\n');
  await chmod(sourceCommand, 0o700);
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
    sourceCommand,
    pathEnv: "/usr/bin"
  });
  assert.equal(
    result.pathFix,
    `export PATH="${join(home, ".local", "bin")}:$PATH"`
  );
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
  assert.equal(config.projects[cwd]?.apiUrl, "https://api.example");
});

test("stored CLI credential recovers project without opening browser", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-setup-"));
  const sourceCommand = join(home, "cli", "dist", "main.js");
  await mkdir(join(home, "cli", "dist"), { recursive: true });
  await writeFile(sourceCommand, "#!/usr/bin/env node\n");
  await writeFile(join(home, "cli", "package.json"), '{"version":"0.1.0"}\n');
  await chmod(sourceCommand, 0o700);
  const store = new Store();
  await store.write("cli:https://api.example", "orch_cli_" + "c".repeat(32));
  const opened: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) =>
    String(input).endsWith("/projects")
      ? response({
          projects: [
            {
              id: "550e8400-e29b-41d4-a716-446655440000",
              name: "Project",
              organization_name: "Org"
            }
          ]
        })
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
    sourceCommand
  });
  assert.equal(opened.length, 0);
});

test("Cursor MCP setup is project-scoped and migrates the legacy user entry", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-setup-cursor-project-"));
  const cwd = join(home, "project");
  const sourceCommand = join(home, "cli", "dist", "main.js");
  const command = join(home, ".local", "bin", "orchestrat");
  await mkdir(join(home, "cli", "dist"), { recursive: true });
  await writeFile(sourceCommand, "#!/usr/bin/env node\n");
  await writeFile(join(home, "cli", "package.json"), '{"version":"0.1.0"}\n');
  await chmod(sourceCommand, 0o700);
  await mkdir(join(home, ".cursor"), { recursive: true });
  await writeFile(
    join(home, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        orchestrat: {
          command,
          args: ["mcp", "--integration", "cursor"]
        }
      }
    })
  );
  const store = new Store();
  await store.write("cli:https://api.example", "orch_cli_" + "c".repeat(32));
  const fetch: typeof globalThis.fetch = async (input) =>
    String(input).endsWith("/projects")
      ? response({
          projects: [
            {
              id: "550e8400-e29b-41d4-a716-446655440000",
              name: "Project",
              organization_name: "Org"
            }
          ]
        })
      : response({
          agent: { id: "550e8400-e29b-41d4-a716-446655440001" },
          credential: { token: "orch_agent_" + "x".repeat(32) }
        });
  await runSetup({
    api: "https://api.example",
    fetch,
    open: async () => {
      assert.fail("stored credential must not open browser authorization");
    },
    sleep: async () => {},
    store,
    cwd,
    home,
    integrations: ["cursor"],
    sourceCommand
  });
  assert.match(
    await readFile(join(cwd, ".cursor", "mcp.json"), "utf8"),
    /"orchestrat"/
  );
  assert.doesNotMatch(
    await readFile(join(home, ".cursor", "mcp.json"), "utf8"),
    /"orchestrat"/
  );
});

test("global Cursor setup grants only the selected projects", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-setup-cursor-global-"));
  const cwd = join(home, "project");
  const sourceCommand = join(home, "cli", "dist", "main.js");
  const first = "550e8400-e29b-41d4-a716-446655440000";
  const second = "550e8400-e29b-41d4-a716-446655440001";
  await mkdir(join(home, "cli", "dist"), { recursive: true });
  await writeFile(sourceCommand, "#!/usr/bin/env node\n");
  await writeFile(join(home, "cli", "package.json"), '{"version":"0.1.0"}\n');
  await chmod(sourceCommand, 0o700);
  const store = new Store();
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const { project_id } = JSON.parse(String(init?.body));
    return response({
      agent: { id: project_id === first ? "first-agent" : "second-agent" },
      credential: { token: `orch_agent_${project_id}` }
    });
  };
  await runSetup({
    api: "https://api.example",
    fetch,
    open: async () => {},
    sleep: async () => {},
    store,
    cwd,
    home,
    integrations: ["codex", "cursor"],
    sourceCommand,
    projectId: first,
    mcpScope: "global",
    authorization: {
      api: "https://api.example",
      credential: "orch_cli_test",
      projects: [
        { id: first, name: "First", organization_name: "Org" },
        { id: second, name: "Second", organization_name: "Org" }
      ]
    },
    globalProjects: [
      { id: first, name: "First", organization_name: "Org" },
      { id: second, name: "Second", organization_name: "Org" }
    ]
  });
  const config = await readConfig(home);
  assert.deepEqual(Object.keys(config.globalProjects?.codex ?? {}), [
    first,
    second
  ]);
  assert.deepEqual(Object.keys(config.globalProjects?.cursor ?? {}), [
    first,
    second
  ]);
  assert.equal(
    await store.read(`agent:${second}:cursor:https://api.example`),
    `orch_agent_${second}`
  );
  assert.equal(
    await store.read(`agent:${first}:cursor:https://api.example`),
    `orch_agent_${first}`
  );
  assert.equal(
    await store.read(`agent:${second}:codex:https://api.example`),
    `orch_agent_${second}`
  );
  assert.match(
    await readFile(join(home, ".codex", "config.toml"), "utf8"),
    /--global/
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8"))
      .mcpServers.orchestrat.args,
    ["mcp", "--integration", "cursor", "--global"]
  );
});

test("rejected stored CLI credential reauthorizes in the browser", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-setup-reauthorize-"));
  const cwd = join(home, "project");
  const sourceCommand = join(home, "cli", "dist", "main.js");
  await mkdir(join(home, "cli", "dist"), { recursive: true });
  await writeFile(sourceCommand, "#!/usr/bin/env node\n");
  await writeFile(join(home, "cli", "package.json"), '{"version":"0.1.0"}\n');
  await chmod(sourceCommand, 0o700);
  const store = new Store();
  await store.write("cli:https://api.example", "orch_cli_" + "s".repeat(32));
  const opened: string[] = [];
  let storedTokenRejected = false;
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/projects") && !storedTokenRejected) {
      storedTokenRejected = true;
      return response({}, 401);
    }
    if (url.endsWith("/attempts"))
      return response(
        {
          attempt_id: "ca_reauthorize",
          secret: "s".repeat(40),
          expires_at: new Date(Date.now() + 60_000).toISOString()
        },
        201
      );
    if (url.endsWith("/poll"))
      return response({
        status: "approved",
        project_id: "550e8400-e29b-41d4-a716-446655440000",
        credential: "orch_cli_" + "n".repeat(32)
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
      agent: { id: "550e8400-e29b-41d4-a716-446655440001" },
      credential: { token: "orch_agent_" + "x".repeat(32) }
    });
  };
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
    integrations: ["codex"],
    sourceCommand
  });
  assert.equal(result.projectId, "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(
    await store.read("cli:https://api.example"),
    "orch_cli_" + "n".repeat(32)
  );
  assert.equal(opened.length, 1);
});

test("stored CLI credential reconciles a stale project mapping before setup", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-setup-project-change-"));
  const cwd = join(home, "project");
  const sourceCommand = join(home, "cli", "dist", "main.js");
  await mkdir(join(home, "cli", "dist"), { recursive: true });
  await writeFile(sourceCommand, "#!/usr/bin/env node\n");
  await writeFile(join(home, "cli", "package.json"), '{"version":"0.1.0"}\n');
  await chmod(sourceCommand, 0o700);
  await mkdir(join(home, ".orchestrat"), { recursive: true });
  await writeFile(
    join(home, ".orchestrat", "config.json"),
    JSON.stringify({
      version: 1,
      projects: {
        [cwd]: {
          projectId: "11111111-1111-4111-8111-111111111111",
          apiUrl: "https://api.example",
          integrations: {
            codex: { agentId: "550e8400-e29b-41d4-a716-446655440009" }
          }
        }
      }
    })
  );
  const store = new Store();
  await store.write("cli:https://api.example", "orch_cli_" + "c".repeat(32));
  await store.write("agent:codex", "orch_agent_" + "o".repeat(32));
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
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
      agent: { id: "550e8400-e29b-41d4-a716-446655440001" },
      credential: { token: "orch_agent_" + "n".repeat(32) }
    });
  };
  const result = await runSetup({
    api: "https://api.example",
    fetch,
    open: async () => {
      assert.fail(
        "valid stored credential must not open browser authorization"
      );
    },
    sleep: async () => {},
    store,
    cwd,
    home,
    integrations: ["codex"],
    sourceCommand
  });
  assert.deepEqual(calls, [
    "https://api.example/api/v1/cli/setup/projects",
    "https://api.example/api/v1/cli/setup"
  ]);
  assert.equal(result.projectId, "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(
    result.integrations.codex?.agentId,
    "550e8400-e29b-41d4-a716-446655440001"
  );
  assert.equal(
    await store.read(
      "agent:550e8400-e29b-41d4-a716-446655440000:codex:https://api.example"
    ),
    "orch_agent_" + "n".repeat(32)
  );
});

test("endpoint transition refreshes authorization and agent credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-setup-transition-"));
  const cwd = join(home, "project");
  const sourceCommand = join(home, "cli", "dist", "main.js");
  await mkdir(join(home, "cli", "dist"), { recursive: true });
  await writeFile(sourceCommand, "#!/usr/bin/env node\n");
  await writeFile(join(home, "cli", "package.json"), '{"version":"0.1.0"}\n');
  await chmod(sourceCommand, 0o700);
  await mkdir(join(home, ".orchestrat"), { recursive: true });
  await writeFile(
    join(home, ".orchestrat", "config.json"),
    JSON.stringify({
      version: 1,
      projects: {
        [cwd]: {
          projectId: "old-project",
          apiUrl: "https://old.example",
          integrations: { codex: { agentId: "old-agent" } }
        }
      }
    })
  );
  const store = new Store();
  await store.write("cli:https://api.example", "old-cli");
  await store.write("agent:codex", "old-agent-token");
  const opened: string[] = [];
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/attempts"))
      return response(
        {
          attempt_id: "ca_transition",
          secret: "s".repeat(40),
          expires_at: new Date(Date.now() + 60_000).toISOString()
        },
        201
      );
    if (url.endsWith("/poll"))
      return response({
        status: "approved",
        project_id: "new-project",
        credential: "new-cli"
      });
    if (url.endsWith("/projects"))
      return response({
        projects: [
          { id: "new-project", name: "Project", organization_name: "Org" }
        ]
      });
    assert.equal(url, "https://new.example/api/v1/cli/setup");
    assert.equal(JSON.parse(String(init?.body)).project_id, "new-project");
    return response({
      agent: { id: "new-agent" },
      credential: { token: "new-agent-token" }
    });
  };
  await runSetup({
    api: "https://new.example",
    fetch,
    open: async (url) => {
      opened.push(url);
    },
    sleep: async () => {},
    store,
    cwd,
    home,
    integrations: ["codex"],
    sourceCommand
  });
  const config = await readConfig(home);
  assert.equal(config.projects[cwd]?.apiUrl, "https://new.example");
  assert.equal(config.projects[cwd]?.projectId, "new-project");
  assert.equal(await store.read("cli:https://new.example"), "new-cli");
  assert.equal(
    await store.read("agent:new-project:codex:https://new.example"),
    "new-agent-token"
  );
  assert.equal(opened.length, 1);
  assert.ok(calls.every((url) => url.startsWith("https://new.example/")));
});

test("partial setup records provisioned agents and names the rejected harness", async () => {
  const home = await mkdtemp(join(tmpdir(), "orch-setup-partial-"));
  const cwd = join(home, "project");
  const sourceCommand = join(home, "cli", "dist", "main.js");
  await mkdir(join(home, "cli", "dist"), { recursive: true });
  await writeFile(sourceCommand, "#!/usr/bin/env node\n");
  await writeFile(join(home, "cli", "package.json"), '{"version":"0.1.0"}\n');
  await chmod(sourceCommand, 0o700);
  const store = new Store();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/attempts"))
      return response(
        {
          attempt_id: "ca_partial",
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
    const integration = JSON.parse(String(init?.body)).integration;
    return integration === "cursor"
      ? response({ error: "unsupported" }, 400)
      : response({
          agent: { id: "550e8400-e29b-41d4-a716-446655440001" },
          credential: { token: "orch_agent_" + "x".repeat(32) }
        });
  };
  await assert.rejects(
    () =>
      runSetup({
        api: "https://api.example",
        fetch,
        open: async () => {},
        sleep: async () => {},
        store,
        cwd,
        home,
        integrations: ["codex", "cursor"],
        sourceCommand
      }),
    /Unable to configure cursor \(API 400\)/
  );
  assert.equal(
    (await readConfig(home)).projects[cwd]?.integrations.codex?.agentId,
    "550e8400-e29b-41d4-a716-446655440001"
  );
  assert.equal(await store.read("agent:cursor"), undefined);
});
