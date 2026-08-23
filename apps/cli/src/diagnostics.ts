import { AgentApiClient } from "@orchestrat/sdk";
import {
  atomicWrite,
  mergeHooks,
  mergeJson,
  mergeToml,
  readOptional,
  removeHooks,
  removeJson,
  removeToml
} from "./safe-files.js";
import {
  configPath,
  findProject,
  readConfig,
  type Integration
} from "./config.js";
import type { CredentialStore } from "./keychain.js";
import { inspectLauncher } from "./setup.js";
import { access, lstat, readlink, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const redacted = (ok: boolean, detail: string) => ({ ok, detail });
const execFileAsync = promisify(execFile);

export async function runStatus(input: {
  home: string;
  cwd: string;
  credentials: { read(account: string): Promise<string | undefined> };
  api: string;
  fetch?: typeof globalThis.fetch;
}) {
  const config = await readConfig(input.home);
  const project = findProject(config, input.cwd);
  const integrations = project ? Object.keys(project.integrations) : [];
  const backend: Record<string, unknown> = {};
  for (const integration of integrations as Integration[]) {
    const mapping = project?.integrations[integration];
    const token =
      (await input.credentials.read(`agent:${integration}`)) ??
      (await input.credentials.read(integration));
    if (!token) {
      backend[integration] = redacted(false, "missing credential");
      continue;
    }
    try {
      const presence = await new AgentApiClient({
        baseUrl: input.api,
        token,
        fetch: input.fetch
      }).getPresence();
      const agent = presence.agents.find(
        (item) => item.agent_id === mapping?.agentId
      );
      backend[integration] = {
        reachable: true,
        agent_id: mapping?.agentId ?? null,
        status: agent?.status ?? "missing",
        session_id: agent?.session_id ?? null,
        last_heartbeat_at: agent?.last_heartbeat_at ?? null
      };
    } catch {
      backend[integration] = redacted(false, "API unreachable or unauthorized");
    }
  }
  return {
    configured: Boolean(project),
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
  const project = config ? findProject(config, input.cwd) : undefined;
  checks.mapping = redacted(Boolean(project), project ? "present" : "missing");
  const cliToken = await input.credentials.read("cli");
  checks.cli_credential = redacted(
    Boolean(cliToken),
    cliToken ? "present" : "missing"
  );
  if (cliToken) {
    try {
      const response = await (input.fetch ?? globalThis.fetch)(
        `${input.api}/api/v1/cli/setup/project`,
        {
          headers: { authorization: `Bearer ${cliToken}` }
        }
      );
      if (!response.ok) throw new Error("unreachable");
      const remote = (await response.json()) as { project_id?: string };
      checks.cli_project = redacted(
        remote.project_id === project?.projectId,
        remote.project_id === project?.projectId
          ? "matches"
          : "different project"
      );
    } catch {
      checks.cli_project = redacted(false, "unreachable or unauthorized");
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
      if (launcher.changed) throw new Error("launcher missing");
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
  if (project && input.sourceCommand) {
    const command = join(input.home, ".local", "bin", "orchestrat");
    for (const integration of Object.keys(
      project.integrations
    ) as Integration[]) {
      const mcpPath =
        integration === "codex"
          ? join(input.home, ".codex", "config.toml")
          : join(input.home, ".claude.json");
      const hookPath =
        integration === "codex"
          ? join(input.home, ".codex", "hooks.json")
          : join(input.home, ".claude", "settings.json");
      try {
        const mcp = await readOptional(mcpPath);
        const hooks = await readOptional(hookPath);
        const mergedMcp =
          integration === "codex"
            ? mergeToml(mcp, integration, command)
            : mergeJson(mcp, integration, command);
        const mergedHooks = mergeHooks(hooks, integration, command);
        checks[`config.${integration}`] = redacted(
          mcp === mergedMcp && hooks === mergedHooks,
          mcp === mergedMcp && hooks === mergedHooks
            ? "present"
            : "missing or outdated"
        );
      } catch {
        checks[`config.${integration}`] = redacted(
          false,
          "malformed or conflicting"
        );
      }
    }
  }
  for (const integration of (project
    ? Object.keys(project.integrations)
    : []) as Integration[]) {
    const mapping = project!.integrations[integration]!;
    const token =
      (await input.credentials.read(`agent:${integration}`)) ??
      (await input.credentials.read(integration));
    checks[`credential.${integration}`] = redacted(
      Boolean(token),
      token ? "present" : "missing"
    );
    if (token) {
      try {
        const presence = await new AgentApiClient({
          baseUrl: input.api,
          token,
          fetch: input.fetch
        }).getPresence();
        const agent = presence.agents.find(
          (item) => item.agent_id === mapping.agentId
        );
        checks[`backend.${integration}`] = redacted(
          Boolean(agent),
          agent
            ? `mapped ${agent.status} session ${agent.session_id ?? "none"} heartbeat ${agent.last_heartbeat_at ?? "none"}`
            : "mapped agent missing"
        );
      } catch {
        checks[`backend.${integration}`] = redacted(
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
  fetch?: typeof globalThis.fetch;
  sourceCommand: string;
  reportPreview?: (
    previews: { path: string; entries: string[] }[]
  ) => void | Promise<void>;
}) {
  const config = await readConfig(input.home);
  const project = findProject(config, input.cwd);
  const selected =
    input.integration === "all"
      ? (["codex", "claude-code"] as const)
      : [input.integration];
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
    if (otherProjectUses) continue;
    const mcpPath =
      name === "codex"
        ? join(input.home, ".codex", "config.toml")
        : join(input.home, ".claude.json");
    const hookPath =
      name === "codex"
        ? join(input.home, ".codex", "hooks.json")
        : join(input.home, ".claude", "settings.json");
    const mcp = await readOptional(mcpPath);
    const hooks = await readOptional(hookPath);
    const nextMcp =
      name === "codex"
        ? removeToml(mcp, name, command)
        : removeJson(mcp, name, command);
    const nextHooks = removeHooks(hooks, name, command);
    if (nextMcp !== mcp)
      writes.push({
        path: mcpPath,
        entries: [
          name === "codex" ? "mcp_servers.orchestrat" : "mcpServers.orchestrat"
        ],
        content: nextMcp ?? ""
      });
    if (nextHooks !== hooks)
      writes.push({
        path: hookPath,
        entries: [
          "SessionStart",
          "SessionEnd",
          ...(name === "claude-code" ? ["StopFailure"] : [])
        ],
        content: nextHooks ?? ""
      });
  }
  const nextConfig = structuredClone(config);
  const nextProject = nextConfig.projects[project.cwd]!;
  for (const name of mapped) delete nextProject.integrations[name];
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
    try {
      if (
        (await lstat(launcher.path)).isSymbolicLink() &&
        (await readlink(launcher.path)) === input.sourceCommand
      )
        launcherPath = launcher.path;
    } catch {
      launcherPath = undefined;
    }
  }
  const previews = [
    ...writes.map(({ path, entries }) => ({ path, entries })),
    ...(launcherPath ? [{ path: launcherPath, entries: ["launcher"] }] : [])
  ];
  await input.reportPreview?.(previews);
  const cliToken = await input.store.read("cli");
  if (!cliToken)
    throw new Error(
      "CLI credential is required before disconnecting a mapped agent"
    );
  {
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
  if (launcherPath) await rm(launcherPath, { force: true });
  for (const name of mapped) {
    const otherProjectUses = Object.entries(config.projects).some(
      ([cwd, value]) => cwd !== project.cwd && Boolean(value.integrations[name])
    );
    if (otherProjectUses) continue;
    await input.store.remove(`agent:${name}`);
    await input.store.remove(name);
  }
  if (!integrationsRemain) await input.store.remove("cli");
  return { previews, disconnected: mapped };
}
