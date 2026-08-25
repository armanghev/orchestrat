import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const commandAvailable = async (command: string) => {
  try {
    await execFileAsync(command, ["--version"], {
      timeout: 1500,
      maxBuffer: 1024,
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
};
import {
  access,
  lstat,
  readFile,
  copyFile,
  chmod,
  realpath,
  symlink,
  rename,
  readdir,
  mkdir,
  rm,
  writeFile
} from "node:fs/promises";
const applicationAvailable = async (name: string) => {
  for (const directory of ["/Applications", join(homedir(), "Applications")])
    try {
      await access(join(directory, name));
      return true;
    } catch {
      // Try the next standard macOS application directory.
    }
  return false;
};
const noApplication = async () => false;
import { atomicWrite, readOptional, removeHarnessMcp } from "./safe-files.js";
import {
  agentAccount,
  legacyAgentAccount,
  type CredentialStore
} from "./keychain.js";
import {
  readConfig,
  configPath,
  canonicalizeCwd,
  type Integration,
  type McpScope,
  type OrchestratConfig,
  validateApiUrl
} from "./config.js";
import {
  HARNESSES,
  isConfigurableIntegration,
  type HarnessRecord
} from "./harnesses.js";
import { harnessConfigPlan, previewHarnessConfig } from "./harness-config.js";
import type { ProjectChoice } from "./ui.js";

export type SetupTransport = {
  fetch: typeof globalThis.fetch;
  open: (url: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  api: string;
};
export async function detectIntegrations(
  probe: (command: string) => Promise<boolean> = commandAvailable,
  probeApplication: (name: string) => Promise<boolean> = probe ===
  commandAvailable
    ? applicationAvailable
    : noApplication
) {
  const found = (await detectHarnesses(probe, probeApplication))
    .filter((item) => item.configurable)
    .map((item) => item.id)
    .filter(isConfigurableIntegration);
  if (!found.length) throw new Error("No supported agent integrations found");
  return found;
}

export async function detectHarnesses(
  probe: (command: string) => Promise<boolean> = commandAvailable,
  probeApplication: (name: string) => Promise<boolean> = probe ===
  commandAvailable
    ? applicationAvailable
    : noApplication
): Promise<(HarnessRecord & { detected: boolean })[]> {
  const detected: (HarnessRecord & { detected: boolean })[] = [];
  for (const item of HARNESSES) {
    const commands = item.commands ?? [item.command];
    let available = false;
    for (const command of commands) {
      if (await probe(command)) {
        available = true;
        break;
      }
    }
    if (!available)
      for (const application of item.applications ?? []) {
        if (await probeApplication(application)) {
          available = true;
          break;
        }
      }
    if (available) detected.push({ ...item, detected: true });
  }
  return detected;
}
export async function installLauncher(home: string, sourceCommand: string) {
  const resolvedSource = await realpath(sourceCommand);
  const preview = await inspectLauncher(home, resolvedSource);
  const target = join(home, ".local", "bin", "orchestrat");
  if (!preview.changed) return target;
  const runtimeRoot = join(home, ".orchestrat", "runtimes");
  const runtime = join(
    runtimeRoot,
    `runtime-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const sourceDirectory = dirname(resolvedSource);
  const sourcePackage =
    basename(sourceDirectory) === "dist"
      ? dirname(sourceDirectory)
      : sourceDirectory;
  let installed = false;
  try {
    await mkdir(join(runtime, "dist"), { recursive: true, mode: 0o700 });
    await copyFile(resolvedSource, join(runtime, "dist", "main.js"));
    await chmod(join(runtime, "dist", "main.js"), 0o700);
    await copyFile(
      join(sourcePackage, "package.json"),
      join(runtime, "package.json")
    );
    await writeFile(
      join(runtime, "source.txt"),
      `${resolvedSource}\n${await sourceFingerprint(resolvedSource)}\n`
    );
    const temporary = join(
      dirname(target),
      `.orchestrat-launcher-${process.pid}`
    );
    await symlink(join(runtime, "dist", "main.js"), temporary);
    await rename(temporary, target);
    installed = true;
  } finally {
    if (!installed && (await exists(runtime)))
      await rm(runtime, { recursive: true, force: true });
  }
  await pruneRuntimes(runtimeRoot, runtime);
  return target;
}
async function sourceFingerprint(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
export async function inspectLauncher(home: string, sourceCommand: string) {
  if (!sourceCommand.startsWith("/"))
    throw new Error("Persistent CLI command must be absolute");
  const target = join(home, ".local", "bin", "orchestrat");
  let resolvedSource = sourceCommand;
  try {
    resolvedSource = await realpath(sourceCommand);
  } catch {
    // The caller will report a missing source when installation is attempted.
  }
  let existing: Awaited<ReturnType<typeof lstat>>;
  try {
    existing = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path: target, changed: true, managed: false };
    throw error;
  }
  if (!existing.isSymbolicLink())
    throw new Error("Existing persistent CLI launcher conflicts");
  const linked = await realpath(target);
  let runtimeRoot: string;
  try {
    runtimeRoot = await realpath(join(home, ".orchestrat", "runtimes"));
  } catch {
    if (linked === resolve(resolvedSource))
      return { path: target, changed: true, managed: true };
    throw new Error("Existing persistent CLI launcher conflicts");
  }
  if (linked.startsWith(`${runtimeRoot}/`) && basename(linked) === "main.js") {
    if (linked === resolve(resolvedSource))
      return { path: target, changed: false, managed: true };
    const installedSource = await readFile(
      join(dirname(dirname(linked)), "source.txt"),
      "utf8"
    );
    return {
      path: target,
      changed:
        installedSource.trim() !==
        `${resolvedSource}\n${await sourceFingerprint(resolvedSource)}`,
      managed: true
    };
  }
  if (linked === resolve(resolvedSource))
    return { path: target, changed: true, managed: true };
  throw new Error("Existing persistent CLI launcher conflicts");
}
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
async function pruneRuntimes(runtimeRoot: string, current: string) {
  for (const name of await readdir(runtimeRoot)) {
    const path = join(runtimeRoot, name);
    if (path !== current) await rm(path, { recursive: true, force: true });
  }
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
  const webUrl = process.env.ORCHESTRAT_WEB_URL ?? "https://app.orchestrat.dev";
  let origin: string;
  try {
    const url = new URL(webUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("Invalid ORCHESTRAT_WEB_URL");
    origin = url.origin;
  } catch {
    throw new Error("Invalid ORCHESTRAT_WEB_URL");
  }
  await transport.open(
    `${origin}/cli/authorize?attempt=${encodeURIComponent(attempt.attempt_id)}`
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
    };
    if (result.status === "pending") {
      await transport.sleep(2000);
      continue;
    }
    if (result.status !== "approved" || !result.credential)
      throw new Error(`Browser authorization ${result.status}`);
    await store.write(account, result.credential);
    return resolveSetupAuthorization(transport, store);
  }
}

export type SetupAuthorization = {
  credential: string;
  projects: ProjectChoice[];
};

export async function resolveSetupAuthorization(
  transport: SetupTransport,
  store: CredentialStore,
  forceAuthorization = false
): Promise<SetupAuthorization> {
  const credential = await store.read("cli");
  if (!credential || forceAuthorization)
    return authorizeCli(transport, store);
  const response = await transport.fetch(
    `${transport.api}/api/v1/cli/setup/projects`,
    { headers: { authorization: `Bearer ${credential}` } }
  );
  if (response.status === 401 || response.status === 403)
    return authorizeCli(transport, store);
  if (!response.ok) throw new Error("Unable to resolve CLI projects");
  const result = (await response.json()) as { projects?: ProjectChoice[] };
  if (!Array.isArray(result.projects)) throw new Error("CLI projects were not returned");
  return { credential, projects: result.projects };
}

export type SetupPreview = {
  integration?: Integration;
  path: string;
  changed: boolean;
  entries?: string[];
  capability?: "mcp" | "hooks";
};

function removeLegacyMcp(
  source: string | undefined,
  integration: Integration,
  command: string,
  projectRoot: string,
  globalMcp: { merge: (text: string | undefined) => string }
) {
  try {
    globalMcp.merge(source);
    return source;
  } catch {
    try {
      return removeHarnessMcp(source, integration, command);
    } catch {
      return removeHarnessMcp(source, integration, command, projectRoot);
    }
  }
}

export async function previewSetup(
  home: string,
  integrations: Integration[],
  command: string,
  projectRoot = home,
  mcpScopes: Partial<Record<Integration, McpScope>> = {}
) {
  if (!command.startsWith("/"))
    throw new Error("Persistent CLI command must be absolute");
  const result: SetupPreview[] = [];
  for (const integration of integrations) {
    const mcpScope = mcpScopes[integration] ?? "project";
    if (mcpScope === "global") {
      const plan = harnessConfigPlan(
        home,
        integration,
        command,
        projectRoot,
        mcpScope
      );
      for (const [capability, item] of [
        ["mcp", plan.mcp],
        ["hooks", plan.hooks]
      ] as const) {
        if (!item) continue;
        const source = await readOptional(item.path);
        const migrated =
          capability === "mcp"
            ? removeLegacyMcp(source, integration, command, projectRoot, item)
            : source;
        result.push({
          integration,
          path: item.path,
          changed: source !== item.merge(migrated),
          entries: item.entries,
          capability
        });
      }
      continue;
    }
    result.push(
      ...(await previewHarnessConfig(
        home,
        integration,
        command,
        projectRoot,
        mcpScope
      ))
    );
  }
  if (
    integrations.includes("cursor") &&
    (mcpScopes.cursor ?? "project") !== "global" &&
    projectRoot !== home
  ) {
    const legacy = harnessConfigPlan(home, "cursor", command).mcp!;
    const source = await readOptional(legacy.path);
    const next = legacy.remove(source);
    if (next !== source)
      result.push({
        integration: "cursor",
        path: legacy.path,
        changed: true,
        entries: legacy.entries,
        capability: "mcp"
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
  authorization?: SetupAuthorization;
  projectId?: string;
  mcpScope?: McpScope;
  globalProjects?: ProjectChoice[];
  pathEnv?: string;
  reportPreview?: (previews: SetupPreview[]) => Promise<void> | void;
};
export async function runSetup(options: SetupRunOptions) {
  const sourceCommand = await realpath(options.sourceCommand);
  if (!sourceCommand.startsWith("/"))
    throw new Error("Persistent CLI command must be absolute");
  const launcher = await inspectLauncher(options.home, sourceCommand);
  const command = launcher.path;
  let config = await readConfig(options.home);
  const key = canonicalizeCwd(options.cwd);
  const existing = config.projects[key];
  const apiUrl = validateApiUrl(options.api);
  const apiChanged = existing !== undefined && existing.apiUrl !== apiUrl;
  const mcpScopes = { ...(existing?.mcpScopes ?? {}) };
  for (const integration of options.integrations)
    mcpScopes[integration] = options.mcpScope ?? mcpScopes[integration] ?? "project";
  const configPreviews = await previewSetup(
    options.home,
    options.integrations,
    command,
    key,
    mcpScopes
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
  const authorization =
    options.authorization ??
    (await resolveSetupAuthorization(options, options.store, apiChanged));
  const { credential: cliToken, projects } = authorization;
  const projectId =
    options.projectId ??
    (existing && projects.some((project) => project.id === existing.projectId)
      ? existing.projectId
      : projects.length === 1
        ? projects[0]!.id
        : undefined);
  if (!projectId) throw new Error("Select a project by running setup in an interactive terminal");
  const projectChanged = existing?.projectId !== projectId;
  const integrations: Record<string, { agentId: string }> =
    apiChanged || projectChanged ? {} : { ...(existing?.integrations ?? {}) };
  const globalIntegrations = options.integrations.filter(
    (integration) => mcpScopes[integration] === "global"
  );
  const selectedGlobalProjects =
    globalIntegrations.length
      ? options.globalProjects ?? projects
      : [];
  if (
    globalIntegrations.length &&
    !selectedGlobalProjects.length
  )
    throw new Error("Select at least one project for global MCP");
  const globalMappings = { ...(config.globalProjects ?? {}) };
  for (const integration of globalIntegrations) globalMappings[integration] = {};
  const persistMapping = async () => {
    config = {
      version: 1,
      projects: {
        ...config.projects,
        [key]: {
          projectId,
          apiUrl,
          ...(Object.keys(mcpScopes).length ? { mcpScopes } : {}),
          integrations
        }
      },
      ...(Object.keys(globalMappings).length
        ? { globalProjects: globalMappings }
        : {})
    } as OrchestratConfig;
    await atomicWrite(
      configPath(options.home),
      `${JSON.stringify(config, null, 2)}\n`
    );
  };
  for (const integration of options.integrations) {
    const account = agentAccount(projectId, integration);
    const legacy = legacyAgentAccount(integration);
    const existingCredential =
      (await options.store.read(account)) ??
      (projectChanged ? undefined : await options.store.read(legacy));
    if (
      integrations[integration]?.agentId &&
      existingCredential
    ) {
      if (!(await options.store.read(account)))
        await options.store.write(account, existingCredential);
      continue;
    }
    const response = await options.fetch(`${options.api}/api/v1/cli/setup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cliToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ project_id: projectId, integration })
    });
    if (!response.ok)
      throw new Error(
        `Unable to configure ${integration} (API ${response.status})`
      );
    const result = (await response.json()) as {
      agent: { id: string };
      credential: { token: string };
    };
    await options.store.write(account, result.credential.token);
    integrations[integration] = { agentId: result.agent.id };
    await persistMapping();
  }
  for (const integration of globalIntegrations)
    for (const project of selectedGlobalProjects) {
      const account = agentAccount(project.id, integration);
      const mapped =
        project.id === projectId
          ? integrations[integration]
          : globalMappings[integration]?.[project.id];
      let agentId = mapped?.agentId;
      if (!agentId || !(await options.store.read(account))) {
        const response = await options.fetch(`${options.api}/api/v1/cli/setup`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${cliToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ project_id: project.id, integration })
        });
        if (!response.ok)
          throw new Error(`Unable to configure ${integration} for ${project.organization_name} / ${project.name} (API ${response.status})`);
        const result = (await response.json()) as {
          agent: { id: string };
          credential: { token: string };
        };
        agentId = result.agent.id;
        await options.store.write(account, result.credential.token);
      }
      globalMappings[integration]![project.id] = {
        name: project.name,
        organizationName: project.organization_name,
        apiUrl,
        agentId
      };
      await persistMapping();
    }
  await persistMapping();
  for (const integration of options.integrations) {
    const plan = harnessConfigPlan(
      options.home,
      integration,
      command,
      key,
      mcpScopes[integration]
    );
    for (const item of [plan.mcp, plan.hooks]) {
      if (!item) continue;
      let source = await readOptional(item.path);
      if (mcpScopes[integration] === "global" && item === plan.mcp) {
        source = removeLegacyMcp(source, integration, command, key, item);
      }
      await atomicWrite(item.path, item.merge(source));
    }
  }
  if (
    options.integrations.includes("cursor") &&
    (mcpScopes.cursor ?? "project") !== "global" &&
    key !== options.home
  ) {
    const legacy = harnessConfigPlan(options.home, "cursor", command).mcp!;
    const source = await readOptional(legacy.path);
    const next = legacy.remove(source);
    if (next !== source) await atomicWrite(legacy.path, next ?? "");
  }
  if ((await inspectLauncher(options.home, sourceCommand)).changed)
    throw new Error("Persistent CLI launcher verification failed");
  for (const integration of options.integrations) {
    const plan = harnessConfigPlan(
      options.home,
      integration,
      command,
      key,
      mcpScopes[integration]
    );
    for (const item of [plan.mcp, plan.hooks]) {
      if (item) item.merge(await readOptional(item.path));
    }
  }
  const localBin = join(options.home, ".local", "bin");
  const pathEntries = (options.pathEnv ?? process.env.PATH ?? "").split(":");
  const pathFix = pathEntries.includes(localBin)
    ? undefined
    : `export PATH="${localBin}:$PATH"`;
  return { projectId, integrations, pathFix };
}
