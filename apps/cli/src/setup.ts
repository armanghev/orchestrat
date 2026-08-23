import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import {
  lstat,
  readlink,
  symlink,
  rename,
  mkdtemp,
  mkdir,
  rm
} from "node:fs/promises";
import {
  atomicWrite,
  mergeJson,
  mergeHooks,
  mergeToml,
  readOptional
} from "./safe-files.js";
import type { CredentialStore } from "./keychain.js";
import {
  readConfig,
  configPath,
  canonicalizeCwd,
  type Integration,
  type OrchestratConfig
} from "./config.js";

export type SetupTransport = {
  fetch: typeof globalThis.fetch;
  open: (url: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  api: string;
};
export async function detectIntegrations(
  probe: (command: string) => Promise<boolean> = async (command) => {
    try {
      await execFileAsync(command, ["--version"]);
      return true;
    } catch {
      return false;
    }
  }
) {
  const found: ("codex" | "claude-code")[] = [];
  if (await probe("codex")) found.push("codex");
  if (await probe("claude")) found.push("claude-code");
  if (!found.length)
    throw new Error("No supported agent integrations found (codex or claude)");
  return found;
}
export async function installLauncher(home: string, sourceCommand: string) {
  const preview = await inspectLauncher(home, sourceCommand);
  if (!preview.changed) return preview.path;
  const target = join(home, ".local", "bin", "orchestrat");
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing) {
    if (existing.isSymbolicLink() && (await readlink(target)) === sourceCommand)
      return target;
    throw new Error("Existing persistent CLI launcher conflicts");
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(
    join(dirname(target), ".orchestrat-launcher-")
  );
  try {
    const temporary = join(directory, "orchestrat");
    await symlink(sourceCommand, temporary);
    await rename(temporary, target);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return target;
}
export async function inspectLauncher(home: string, sourceCommand: string) {
  if (!sourceCommand.startsWith("/"))
    throw new Error("Persistent CLI command must be absolute");
  const target = join(home, ".local", "bin", "orchestrat");
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() && (await readlink(target)) === sourceCommand)
      return { path: target, changed: false };
    throw new Error("Existing persistent CLI launcher conflicts");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { path: target, changed: true };
}
export async function authorizeCli(
  transport: SetupTransport,
  store: CredentialStore,
  account = "cli"
) {
  const created = await transport.fetch(
    `${transport.api}/api/v1/cli/authorization/attempts`,
    { method: "POST" }
  );
  if (!created.ok) throw new Error("Unable to start browser authorization");
  const attempt = (await created.json()) as {
    attempt_id: string;
    secret: string;
    expires_at: string;
  };
  await transport.open(
    `https://app.orchestrat.dev/cli/authorize?attempt=${encodeURIComponent(attempt.attempt_id)}`
  );
  for (;;) {
    if (Date.now() >= Date.parse(attempt.expires_at))
      throw new Error("Browser authorization expired");
    const response = await transport.fetch(
      `${transport.api}/api/v1/cli/authorization/attempts/${encodeURIComponent(attempt.attempt_id)}/poll`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: attempt.secret })
      }
    );
    if (response.status === 429) {
      await transport.sleep(2000);
      continue;
    }
    if (!response.ok) throw new Error("Browser authorization failed");
    const result = (await response.json()) as {
      status: string;
      credential?: string;
      project_id?: string;
    };
    if (result.status === "pending") {
      await transport.sleep(2000);
      continue;
    }
    if (result.status !== "approved" || !result.credential)
      throw new Error(`Browser authorization ${result.status}`);
    if (!result.project_id)
      throw new Error("Browser authorization returned no project");
    await store.write(account, result.credential);
    return { credential: result.credential, projectId: result.project_id };
  }
}

export type SetupPreview = {
  integration?: "codex" | "claude-code";
  path: string;
  changed: boolean;
  entries?: string[];
};
export async function previewSetup(
  home: string,
  integrations: ("codex" | "claude-code")[],
  command: string
) {
  if (!command.startsWith("/"))
    throw new Error("Persistent CLI command must be absolute");
  const result: SetupPreview[] = [];
  for (const integration of integrations) {
    const path =
      integration === "codex"
        ? join(home, ".codex", "config.toml")
        : join(home, ".claude.json");
    const source = await readOptional(path);
    const next =
      integration === "codex"
        ? mergeToml(source, integration, command)
        : mergeJson(source, integration, command);
    result.push({
      integration,
      path,
      changed: source !== next,
      entries: [
        integration === "codex"
          ? "mcp_servers.orchestrat"
          : "mcpServers.orchestrat"
      ]
    });
    const hookPath =
      integration === "codex"
        ? join(home, ".codex", "hooks.json")
        : join(home, ".claude", "settings.json");
    const hookSource = await readOptional(hookPath);
    const hookNext = mergeHooks(hookSource, integration, command);
    result.push({
      integration,
      path: hookPath,
      changed: hookSource !== hookNext,
      entries:
        integration === "codex"
          ? ["SessionStart", "SessionEnd"]
          : ["SessionStart", "SessionEnd", "StopFailure"]
    });
  }
  return result;
}

export type SetupRunOptions = SetupTransport & {
  store: CredentialStore;
  cwd: string;
  home: string;
  integrations: Integration[];
  sourceCommand: string;
  reportPreview?: (previews: SetupPreview[]) => Promise<void> | void;
};
export async function runSetup(options: SetupRunOptions) {
  const sourceCommand = options.sourceCommand;
  if (!sourceCommand.startsWith("/"))
    throw new Error("Persistent CLI command must be absolute");
  const launcher = await inspectLauncher(options.home, sourceCommand);
  const command = launcher.path;
  let config = await readConfig(options.home);
  const key = canonicalizeCwd(options.cwd);
  const existing = config.projects[key];
  const configPreviews = await previewSetup(
    options.home,
    options.integrations,
    command
  );
  const previews: SetupPreview[] = [
    {
      path: launcher.path,
      changed: launcher.changed,
      entries: ["launcher"]
    },
    ...configPreviews
  ];
  await options.reportPreview?.(previews);
  await installLauncher(options.home, sourceCommand);
  const cli = await options.store.read("cli");
  let cliToken = cli;
  let approvedProject = existing?.projectId;
  if (!cliToken) {
    const authorized = await authorizeCli(options, options.store);
    cliToken = authorized.credential;
    approvedProject = authorized.projectId;
  } else if (!approvedProject) {
    const response = await options.fetch(
      `${options.api}/api/v1/cli/setup/project`,
      { headers: { authorization: `Bearer ${cliToken}` } }
    );
    if (!response.ok) throw new Error("Unable to resolve the CLI project");
    approvedProject = ((await response.json()) as { project_id: string })
      .project_id;
  }
  const projectId = approvedProject;
  if (!projectId) throw new Error("A project must be selected during setup");
  const integrations: Record<string, { agentId: string }> = {
    ...(existing?.integrations ?? {})
  };
  for (const integration of options.integrations) {
    const account = `agent:${integration}`;
    if (
      integrations[integration]?.agentId &&
      (await options.store.read(account))
    )
      continue;
    const response = await options.fetch(`${options.api}/api/v1/cli/setup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ project_id: projectId, integration })
    });
    if (!response.ok) throw new Error("Unable to configure integration");
    const result = (await response.json()) as {
      agent: { id: string };
      credential: { token: string };
    };
    await options.store.write(account, result.credential.token);
    integrations[integration] = { agentId: result.agent.id };
  }
  config = {
    version: 1,
    projects: { ...config.projects, [key]: { projectId, integrations } }
  } as OrchestratConfig;
  await atomicWrite(
    configPath(options.home),
    `${JSON.stringify(config, null, 2)}\n`
  );
  for (const preview of configPreviews) {
    const source = await readOptional(preview.path);
    const next =
      preview.path.endsWith("hooks.json") ||
      preview.path.endsWith("settings.json")
        ? mergeHooks(source, preview.integration!, command)
        : preview.integration === "codex"
          ? mergeToml(source, "codex", command)
          : mergeJson(source, "claude-code", command);
    await atomicWrite(preview.path, next);
  }
  if ((await inspectLauncher(options.home, sourceCommand)).changed)
    throw new Error("Persistent CLI launcher verification failed");
  for (const preview of configPreviews) {
    const source = await readOptional(preview.path);
    if (
      preview.path.endsWith("hooks.json") ||
      preview.path.endsWith("settings.json")
    )
      mergeHooks(source, preview.integration!, command);
    else if (preview.integration === "codex")
      mergeToml(source, "codex", command);
    else mergeJson(source, "claude-code", command);
  }
  return { projectId, integrations };
}
