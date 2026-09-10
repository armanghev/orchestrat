import { AgentApiClient } from "@orchestrat/sdk";
import { atomicWrite, readOptional } from "./safe-files.js";
import {
  configPath,
  findProject,
  INTEGRATIONS,
  readConfig,
  type Integration,
  type OrchestratConfig
} from "./config.js";
import { harnessConfigPlan } from "./harness-config.js";
import {
  agentAccount,
  legacyAgentAccount,
  type CredentialStore
} from "./keychain.js";
import { inspectLauncher } from "./setup.js";
import { access, lstat, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const redacted = (ok: boolean, detail: string) => ({ ok, detail });
const execFileAsync = promisify(execFile);

function diagnosticConnections(
  config: OrchestratConfig,
  cwd: string,
  api: string
) {
  const project = findProject(config, cwd);
  const connections = project
    ? INTEGRATIONS.filter(
        (integration) => project.integrations[integration]
      ).map((integration) => ({
        key: integration as string,
        integration,
        projectId: project.projectId,
        agentId: project.integrations[integration]!.agentId,
        api,
        scope: project.mcpScopes?.[integration] ?? "project"
      }))
    : INTEGRATIONS.flatMap((integration) =>
        Object.entries(config.globalProjects?.[integration] ?? {}).map(
          ([projectId, mapping]) => ({
            key: `${integration}:${projectId}`,
            integration,
            projectId,
            agentId: mapping.agentId,
            api: mapping.apiUrl ?? api,
            scope: "global" as const
          })
        )
      );
  return { project, connections };
}

async function connectionCredential(
  credentials: { read(account: string): Promise<string | undefined> },
  connection: ReturnType<typeof diagnosticConnections>["connections"][number]
) {
  const token = await credentials.read(
    agentAccount(connection.projectId, connection.integration)
  );
  if (token || connection.scope === "global") return token;
  return (
    (await credentials.read(legacyAgentAccount(connection.integration))) ??
    credentials.read(connection.integration)
  );
}

export async function runStatus(input: {
  home: string;
  cwd: string;
  credentials: { read(account: string): Promise<string | undefined> };
  api: string;
  fetch?: typeof globalThis.fetch;
}) {
  const config = await readConfig(input.home);
  const { project, connections } = diagnosticConnections(
    config,
    input.cwd,
    input.api
  );
  const integrations = [
    ...new Set(connections.map((connection) => connection.integration))
  ];
  const backend: Record<string, unknown> = {};
  for (const connection of connections) {
    const token = await connectionCredential(input.credentials, connection);
    if (!token) {
      backend[connection.key] = redacted(false, "missing credential");
      continue;
    }
    try {
      const presence = await new AgentApiClient({
        baseUrl: connection.api,
        token,
        fetch: input.fetch
      }).getPresence();
      const agent = presence.agents.find(
        (item) => item.agent_id === connection.agentId
      );
      backend[connection.key] = {
        reachable: true,
        ok: Boolean(agent),
        agent_id: connection.agentId,
        status: agent?.status ?? "missing",
        session_id: agent?.session_id ?? null,
        last_heartbeat_at: agent?.last_heartbeat_at ?? null
      };
    } catch {
      backend[connection.key] = redacted(
        false,
        "API unreachable or unauthorized"
      );
    }
  }
  return {
    configured: connections.length > 0,
    scope: project ? "project" : "global",
    cwd: input.cwd,
    project_id: project?.projectId ?? null,
    integrations,
    backend
  };
}

export async function runDoctor(input: {
  home: string;
  cwd: string;
  credentials: { read(account: string): Promise<string | undefined> };
  api: string;
  sourceCommand?: string;
  fetch?: typeof globalThis.fetch;
}) {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  let config;
  try {
    config = await readConfig(input.home);
    checks.config = redacted(true, "valid");
  } catch {
    checks.config = redacted(false, "malformed");
  }
  const { project, connections } = config
    ? diagnosticConnections(config, input.cwd, input.api)
    : { project: undefined, connections: [] };
  checks.mapping = redacted(
    connections.length > 0,
    project
      ? "present"
      : connections.length
        ? "global projects configured; select a project in MCP"
        : "missing"
  );
  const cliToken = await input.credentials.read("cli");
  checks.cli_credential = redacted(
    Boolean(cliToken),
    cliToken ? "present" : "missing"
  );
  const origins = [...new Set(connections.map((connection) => connection.api))];
  if (!origins.length) origins.push(input.api);
  for (const origin of cliToken ? origins : []) {
    const key = origins.length === 1 ? "cli_project" : `cli_project:${origin}`;
    try {
      const response = await (input.fetch ?? globalThis.fetch)(
        `${origin}/api/v1/cli/setup/projects`,
        {
          headers: { authorization: `Bearer ${cliToken}` },
          signal: AbortSignal.timeout(5000)
        }
      );
      if (!response.ok) throw new Error("unreachable");
      const remote = (await response.json()) as { projects?: { id: string }[] };
      const matches =
        Array.isArray(remote.projects) &&
        connections
          .filter((connection) => connection.api === origin)
          .every((connection) =>
            remote.projects!.some((item) => item.id === connection.projectId)
          );
      checks[key] = redacted(
        matches,
        matches
          ? "configured projects authorized"
          : "configured project unavailable"
      );
    } catch {
      checks[key] = redacted(false, "unreachable or unauthorized");
    }
  }
  if (input.sourceCommand) {
    try {
      await access(input.sourceCommand, constants.X_OK);
      const launcherPath = join(input.home, ".local", "bin", "orchestrat");
      const launcherStat = await lstat(launcherPath);
      if ((launcherStat.mode & 0o111) === 0)
        throw new Error("launcher is not executable");
      const launcher = await inspectLauncher(input.home, input.sourceCommand);
      if (!launcher.managed) throw new Error("launcher missing");
      const version = await execFileAsync(launcher.path, ["--version"], {
        timeout: 1500,
        maxBuffer: 1024,
        windowsHide: true
      });
      const versionText = version.stdout.trim();
      if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(versionText))
        throw new Error("launcher version unavailable");
      checks.launcher = redacted(true, `present (${versionText})`);
    } catch {
      checks.launcher = redacted(false, "conflict or invalid");
    }
  }
  if (input.sourceCommand) {
    const command = join(input.home, ".local", "bin", "orchestrat");
    const checked = new Set<Integration>();
    for (const connection of connections) {
      const { integration } = connection;
      if (checked.has(integration)) continue;
      checked.add(integration);
      try {
        const plan = harnessConfigPlan(
          input.home,
          integration,
          command,
          project?.cwd ?? input.cwd,
          connection.scope
        );
        let current = true;
        for (const item of [plan.mcp, plan.hooks]) {
          if (!item) continue;
          const source = await readOptional(item.path);
          current = current && source === item.merge(source);
        }
        checks[`config.${integration}`] = redacted(
          current,
          current ? "present" : "missing or outdated"
        );
      } catch {
        checks[`config.${integration}`] = redacted(
          false,
          "malformed or conflicting"
        );
      }
    }
  }
  for (const connection of connections) {
    const token = await connectionCredential(input.credentials, connection);
    checks[`credential.${connection.key}`] = redacted(
      Boolean(token),
      token ? "present" : "missing"
    );
    if (token) {
      try {
        const presence = await new AgentApiClient({
          baseUrl: connection.api,
          token,
          fetch: input.fetch
        }).getPresence();
        const agent = presence.agents.find(
          (item) => item.agent_id === connection.agentId
        );
        checks[`backend.${connection.key}`] = redacted(
          Boolean(agent),
          agent
            ? `mapped ${agent.status} session ${agent.session_id ?? "none"} heartbeat ${agent.last_heartbeat_at ?? "none"}`
            : "mapped agent missing"
        );
      } catch {
        checks[`backend.${connection.key}`] = redacted(
          false,
          "unreachable or unauthorized"
        );
      }
    }
  }
  return { checks };
}

export async function disconnectLocal(input: {
  home: string;
  cwd: string;
  integration: Integration | "all";
  store: CredentialStore;
  api: string;
  localOnly?: boolean;
  fetch?: typeof globalThis.fetch;
  sourceCommand: string;
  reportPreview?: (
    previews: { path: string; entries: string[] }[]
  ) => void | Promise<void>;
}) {
  const config = await readConfig(input.home);
  const project = findProject(config, input.cwd);
  const selected =
    input.integration === "all" ? INTEGRATIONS : [input.integration];
  const mapped = selected.filter(
    (integration) => project?.integrations[integration]
  );
  if (!project || !mapped.length) return { previews: [], disconnected: [] };
  const command = join(input.home, ".local", "bin", "orchestrat");
  const writes: { path: string; entries: string[]; content: string }[] = [];
  for (const name of mapped) {
    const otherProjectUses = Object.entries(config.projects).some(
      ([cwd, value]) => cwd !== project.cwd && Boolean(value.integrations[name])
    );
    const mcpScope = project.mcpScopes?.[name] ?? "project";
    const globalProjectsRemain =
      mcpScope === "global" &&
      Object.keys(config.globalProjects?.[name] ?? {}).some(
        (projectId) => projectId !== project.projectId
      );
    if (
      (otherProjectUses && (name !== "cursor" || mcpScope === "global")) ||
      globalProjectsRemain
    )
      continue;
    const plan = harnessConfigPlan(
      input.home,
      name,
      command,
      project.cwd,
      mcpScope
    );
    for (const item of [plan.mcp, plan.hooks]) {
      if (!item) continue;
      const source = await readOptional(item.path);
      const next = item.remove(source);
      if (next !== source)
        writes.push({
          path: item.path,
          entries: item.entries,
          content: next ?? ""
        });
    }
  }
  const nextConfig = structuredClone(config);
  const nextProject = nextConfig.projects[project.cwd]!;
  for (const name of mapped) delete nextProject.integrations[name];
  for (const name of mapped)
    if (project.mcpScopes?.[name] === "global") {
      delete nextConfig.globalProjects?.[name]?.[project.projectId];
      if (!Object.keys(nextConfig.globalProjects?.[name] ?? {}).length)
        delete nextConfig.globalProjects?.[name];
    }
  if (!Object.keys(nextConfig.globalProjects ?? {}).length)
    delete nextConfig.globalProjects;
  if (!Object.keys(nextProject.integrations).length)
    delete nextConfig.projects[project.cwd];
  writes.push({
    path: configPath(input.home),
    entries: mapped.map((name) => `mapping:${name}`),
    content: `${JSON.stringify(nextConfig, null, 2)}\n`
  });
  const integrationsRemain = Object.values(nextConfig.projects).some(
    (value) => Object.keys(value.integrations).length > 0
  );
  let launcherPath: string | undefined;
  if (!integrationsRemain) {
    const launcher = await inspectLauncher(input.home, input.sourceCommand);
    if (launcher.managed) launcherPath = launcher.path;
  }
  const previews = [
    ...writes.map(({ path, entries }) => ({ path, entries })),
    ...(launcherPath ? [{ path: launcherPath, entries: ["launcher"] }] : [])
  ];
  await input.reportPreview?.(previews);
  if (!input.localOnly) {
    const cliToken = await input.store.read("cli");
    if (!cliToken)
      throw new Error(
        "CLI credential is required before disconnecting a mapped agent"
      );
    const response = await (input.fetch ?? globalThis.fetch)(
      `${input.api}/api/v1/cli/setup/disconnect`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${cliToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          project_id: project.projectId,
          agent_ids: mapped.map((name) => project.integrations[name]!.agentId),
          revoke_cli: !integrationsRemain
        })
      }
    );
    if (!response.ok) throw new Error("Backend disconnect failed");
  }
  for (const write of writes)
    await atomicWrite(write.path, write.content, false);
  if (launcherPath) {
    await rm(launcherPath, { force: true });
    await rm(join(input.home, ".orchestrat", "runtimes"), {
      recursive: true,
      force: true
    });
  }
  for (const name of mapped) {
    const otherProjectUses = Object.entries(config.projects).some(
      ([cwd, value]) => cwd !== project.cwd && Boolean(value.integrations[name])
    );
    await input.store.remove(agentAccount(project.projectId, name));
    if (!otherProjectUses) await input.store.remove(legacyAgentAccount(name));
    await input.store.remove(name);
  }
  if (!integrationsRemain) await input.store.remove("cli");
  return { previews, disconnected: mapped };
}
