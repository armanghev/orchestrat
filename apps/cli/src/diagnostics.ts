import { AgentApiClient } from "@orchestrat/sdk";
import { readOptional, writeManaged } from "./safe-files.js";
import {
  apiOrigin,
  configPath,
  findProject,
  INTEGRATIONS,
  readConfig,
  type Integration,
  type OrchestratConfig
} from "./config.js";
import { attentionPlanOptions, harnessConfigPlan } from "./harness-config.js";
import { agentAccount, cliAccount, type CredentialStore } from "./keychain.js";
import { inspectLauncher } from "./setup.js";
import { checkoutTarget, type CheckoutTarget } from "./branches.js";
import { access, lstat, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";

const redacted = (ok: boolean, detail: string) => ({ ok, detail });
const checkoutJson = (target: CheckoutTarget) =>
  target.checkout && {
    branch: target.checkout.branch,
    detached: target.checkout.branch === null,
    default_branch: target.checkout.defaultBranch,
    override: target.overridden ? target.name : null
  };
const execFileAsync = promisify(execFile);
const optionalOrigin = (value: string | undefined) =>
  value === undefined ? undefined : apiOrigin(value);
const NO_SERVER = "no server URL; run orchestrat setup --server <url>";

function diagnosticConnections(
  config: OrchestratConfig,
  cwd: string,
  api: string | undefined
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
        api: optionalOrigin(api ?? project.apiUrl),
        scope: project.mcpScopes?.[integration] ?? "project"
      }))
    : INTEGRATIONS.flatMap((integration) =>
        Object.entries(config.globalProjects?.[integration] ?? {}).map(
          ([projectId, mapping]) => ({
            key: `${integration}:${projectId}`,
            integration,
            projectId,
            agentId: mapping.agentId,
            api: optionalOrigin(mapping.apiUrl ?? api),
            scope: "global" as const
          })
        )
      );
  return { project, connections };
}

// The servers this directory talks to, so status and doctor can show them.
function connectionServers(
  connections: { api: string | undefined }[],
  api: string | undefined
) {
  const servers = [
    ...new Set(
      connections.flatMap((connection) =>
        connection.api ? [connection.api] : []
      )
    )
  ];
  if (!connections.length && api) servers.push(apiOrigin(api));
  return servers;
}

async function connectionCredential(
  credentials: { read(account: string): Promise<string | undefined> },
  connection: ReturnType<typeof diagnosticConnections>["connections"][number]
) {
  if (!connection.api) return undefined;
  return credentials.read(
    agentAccount(connection.projectId, connection.integration, connection.api)
  );
}

export async function runStatus(input: {
  home: string;
  cwd: string;
  credentials: { read(account: string): Promise<string | undefined> };
  api?: string;
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
  const target = await checkoutTarget(input.cwd, input.home);
  const backend: Record<string, unknown> = {};
  for (const connection of connections) {
    if (!connection.api) {
      backend[connection.key] = redacted(false, NO_SERVER);
      continue;
    }
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
        // The branch the agent's live session is pinned to.
        branch_id: agent?.branch_id ?? null,
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
    servers: connectionServers(connections, input.api),
    integrations,
    ...(target.checkout ? { checkout: checkoutJson(target) } : {}),
    backend
  };
}

export async function runDoctor(input: {
  home: string;
  cwd: string;
  credentials: { read(account: string): Promise<string | undefined> };
  api?: string;
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
  const servers = connectionServers(connections, input.api);
  const serverMissing =
    !servers.length || connections.some((connection) => !connection.api);
  checks.server = redacted(
    !serverMissing,
    servers.length
      ? `${servers.join(", ")}${serverMissing ? `; some connections have ${NO_SERVER}` : ""}`
      : `not configured; run orchestrat setup --server <url> or set ORCHESTRAT_API_URL`
  );
  const target = await checkoutTarget(input.cwd, input.home);
  if (target.checkout) {
    checks.git_head = redacted(
      target.name !== null,
      target.checkout.branch
        ? `on ${target.checkout.branch}`
        : target.name
          ? `detached; the override selects ${target.name}`
          : "detached HEAD; agents use the project's default branch"
    );
    checks.git_origin_head = redacted(
      target.checkout.defaultBranch !== null,
      target.checkout.defaultBranch
        ? `origin/HEAD is ${target.checkout.defaultBranch}`
        : "origin/HEAD is missing; run git remote set-head origin -a"
    );
  }
  checks.mapping = redacted(
    connections.length > 0,
    project
      ? "present"
      : connections.length
        ? "global projects configured; select a project in MCP"
        : "missing"
  );
  checks.cli_credential = servers.length
    ? redacted(true, "present")
    : redacted(false, NO_SERVER);
  for (const origin of servers) {
    const cliToken = await input.credentials.read(cliAccount(origin));
    const key = servers.length === 1 ? "cli_project" : `cli_project:${origin}`;
    if (!cliToken) {
      checks.cli_credential = redacted(
        false,
        "missing for an API; run orchestrat setup"
      );
      checks[key] = redacted(false, "missing credential for this API");
      continue;
    }
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
          connection.scope,
          attentionPlanOptions(config?.attention, integration)
        );
        let current = true;
        for (const item of [plan.mcp, plan.hooks]) {
          if (!item) continue;
          const source = await readOptional(item.path);
          const merged = item.merge(source);
          current =
            current &&
            (source === merged ||
              (item.path.endsWith(".json") &&
                source !== undefined &&
                merged !== undefined &&
                isDeepStrictEqual(JSON.parse(source), JSON.parse(merged))));
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
      token ? "present" : connection.api ? "missing" : NO_SERVER
    );
    if (token && connection.api) {
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
      if (target.name) {
        try {
          const { branches } = await new AgentApiClient({
            baseUrl: connection.api,
            token,
            fetch: input.fetch
          }).branches.list({ name: target.name, include_archived: true });
          const active = branches.some((branch) => !branch.archived_at);
          checks[`branch.${connection.key}`] = redacted(
            active || branches.length === 0,
            active
              ? `${target.name} is registered`
              : branches.length
                ? `${target.name} is archived; agents use the default branch until you run orchestrat branch select`
                : `${target.name} registers with the next agent session`
          );
        } catch {
          checks[`branch.${connection.key}`] = redacted(
            false,
            "branches unavailable (the API may predate branches)"
          );
        }
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
  api?: string;
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
  const api = optionalOrigin(project.apiUrl ?? input.api);
  if (!input.localOnly && !api)
    throw new Error(
      "No Orchestrat server URL for this project; set ORCHESTRAT_API_URL or use --local"
    );
  if (
    !input.localOnly &&
    input.api !== undefined &&
    apiOrigin(input.api) !== api
  )
    throw new Error(
      "Disconnect API differs from the project mapping; use its API or --local"
    );
  // A mapping without apiUrl has no known server, so it never matches.
  const onThisServer = (value: string | undefined) =>
    api !== undefined && value !== undefined && apiOrigin(value) === api;
  const command = join(input.home, ".local", "bin", "orchestrat");
  const writes: {
    path: string;
    entries: string[];
    content: string | undefined;
  }[] = [];
  const hooksRemoved = new Set<Integration>();
  for (const name of mapped) {
    const otherProjectUses = Object.entries(config.projects).some(
      ([cwd, value]) => cwd !== project.cwd && Boolean(value.integrations[name])
    );
    const mcpScope = project.mcpScopes?.[name] ?? "project";
    const globalProjectsRemain = Object.entries(
      config.globalProjects?.[name] ?? {}
    ).some(
      ([projectId, mapping]) =>
        mcpScope !== "global" ||
        projectId !== project.projectId ||
        !onThisServer(mapping.apiUrl)
    );
    const plan = harnessConfigPlan(
      input.home,
      name,
      command,
      project.cwd,
      mcpScope,
      attentionPlanOptions(config.attention, name)
    );
    for (const item of [plan.mcp, plan.hooks]) {
      if (!item) continue;
      if (
        (otherProjectUses || globalProjectsRemain) &&
        (item !== plan.mcp || name !== "cursor" || mcpScope === "global")
      )
        continue;
      if (item !== plan.mcp) hooksRemoved.add(name);
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
    if (
      project.mcpScopes?.[name] === "global" &&
      onThisServer(
        nextConfig.globalProjects?.[name]?.[project.projectId]?.apiUrl
      )
    ) {
      delete nextConfig.globalProjects?.[name]?.[project.projectId];
      if (!Object.keys(nextConfig.globalProjects?.[name] ?? {}).length)
        delete nextConfig.globalProjects?.[name];
    }
  if (!Object.keys(nextConfig.globalProjects ?? {}).length)
    delete nextConfig.globalProjects;
  if (!Object.keys(nextProject.integrations).length)
    delete nextConfig.projects[project.cwd];
  // Once its Stop entries are gone, the integration is no longer opted in.
  if (nextConfig.attention?.continue_on_stop) {
    nextConfig.attention.continue_on_stop =
      nextConfig.attention.continue_on_stop.filter(
        (name) => !hooksRemoved.has(name)
      );
    if (!nextConfig.attention.continue_on_stop.length)
      delete nextConfig.attention.continue_on_stop;
    if (!Object.keys(nextConfig.attention).length) delete nextConfig.attention;
  }
  writes.push({
    path: configPath(input.home),
    entries: mapped.map((name) => `mapping:${name}`),
    content: `${JSON.stringify(nextConfig, null, 2)}\n`
  });
  const remainingMappings = [
    ...Object.values(nextConfig.projects).filter(
      (value) => Object.keys(value.integrations).length
    ),
    ...Object.values(nextConfig.globalProjects ?? {}).flatMap((values) =>
      Object.values(values)
    )
  ];
  const integrationsRemain = remainingMappings.length > 0;
  const originRemains = remainingMappings.some((value) =>
    onThisServer(value.apiUrl)
  );
  const credentialRemains = (name: Integration) =>
    Object.values(nextConfig.projects).some(
      (value) =>
        value.projectId === project.projectId &&
        value.integrations[name] &&
        onThisServer(value.apiUrl)
    ) ||
    onThisServer(
      nextConfig.globalProjects?.[name]?.[project.projectId]?.apiUrl
    );
  const revoked = mapped.filter((name) => !credentialRemains(name));
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
  if (!input.localOnly && api && revoked.length) {
    const cliToken = await input.store.read(cliAccount(api));
    if (!cliToken)
      throw new Error(
        "CLI credential is required before disconnecting a mapped agent"
      );
    const response = await (input.fetch ?? globalThis.fetch)(
      `${api}/api/v1/cli/setup/disconnect`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${cliToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          project_id: project.projectId,
          agent_ids: revoked.map((name) => project.integrations[name]!.agentId),
          revoke_cli: !originRemains
        })
      }
    );
    if (!response.ok) throw new Error("Backend disconnect failed");
  }
  for (const write of writes)
    await writeManaged(write.path, write.content, false);
  if (launcherPath) {
    await rm(launcherPath, { force: true });
    await rm(join(input.home, ".orchestrat", "runtimes"), {
      recursive: true,
      force: true
    });
  }
  if (api) {
    for (const name of revoked)
      await input.store.remove(agentAccount(project.projectId, name, api));
    if (!originRemains) await input.store.remove(cliAccount(api));
  }
  for (const name of mapped) {
    const local = Object.values(nextConfig.projects).filter(
      (value) => value.integrations[name]
    );
    const global = nextConfig.globalProjects?.[name] ?? {};
    if (
      !local.some((value) => value.projectId === project.projectId) &&
      !global[project.projectId]
    )
      await input.store.remove(`agent:${project.projectId}:${name}`);
    if (!local.length && !Object.keys(global).length) {
      await input.store.remove(`agent:${name}`);
      await input.store.remove(name);
    }
  }
  if (!integrationsRemain) await input.store.remove("cli");
  return { previews, disconnected: mapped };
}
