import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import {
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
import {
  atomicWrite,
  readOptional
} from "./safe-files.js";
import type { CredentialStore } from "./keychain.js";
import {
  readConfig,
  configPath,
  canonicalizeCwd,
  type Integration,
  type OrchestratConfig,
  validateApiUrl
} from "./config.js";
import {
  HARNESSES,
  isConfigurableIntegration,
  type HarnessRecord
} from "./harnesses.js";
import { harnessConfigPlan, previewHarnessConfig } from "./harness-config.js";

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
  const found = (await detectHarnesses(probe))
    .filter((item) => item.configurable)
    .map((item) => item.id)
    .filter(isConfigurableIntegration);
  if (!found.length)
    throw new Error("No supported agent integrations found");
  return found;
}

export async function detectHarnesses(
  probe: (command: string) => Promise<boolean> = async (command) => {
    try {
      await execFileAsync(command, ["--version"]);
      return true;
    } catch {
      return false;
    }
  }
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
  integration?: Integration;
  path: string;
  changed: boolean;
  entries?: string[];
  capability?: "mcp" | "hooks";
};
export async function previewSetup(
  home: string,
  integrations: Integration[],
  command: string
) {
  if (!command.startsWith("/"))
    throw new Error("Persistent CLI command must be absolute");
  const result: SetupPreview[] = [];
  for (const integration of integrations)
    result.push(...(await previewHarnessConfig(home, integration, command)));
  return result;
}

export type SetupRunOptions = SetupTransport & {
  store: CredentialStore;
  cwd: string;
  home: string;
  integrations: Integration[];
  sourceCommand: string;
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
  let approvedProject = apiChanged ? undefined : existing?.projectId;
  if (!cliToken || apiChanged) {
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
  const integrations: Record<string, { agentId: string }> = apiChanged
    ? {}
    : { ...(existing?.integrations ?? {}) };
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
    projects: {
      ...config.projects,
      [key]: { projectId, apiUrl, integrations }
    }
  } as OrchestratConfig;
  await atomicWrite(
    configPath(options.home),
    `${JSON.stringify(config, null, 2)}\n`
  );
  for (const integration of options.integrations) {
    const plan = harnessConfigPlan(options.home, integration, command);
    for (const item of [plan.mcp, plan.hooks]) {
      if (!item) continue;
      await atomicWrite(item.path, item.merge(await readOptional(item.path)));
    }
  }
  if ((await inspectLauncher(options.home, sourceCommand)).changed)
    throw new Error("Persistent CLI launcher verification failed");
  for (const integration of options.integrations) {
    const plan = harnessConfigPlan(options.home, integration, command);
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
