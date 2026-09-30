#!/usr/bin/env node

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { AgentApiClient } from "@orchestrat/sdk";
import { startStdioBridge } from "@orchestrat/mcp";
import {
  detectHarnesses,
  resolveSetupAuthorization,
  runSetup
} from "./setup.js";
import {
  isConfigurableIntegration,
  type ConfigurableIntegration
} from "./harnesses.js";
import { KeychainCredentialStore } from "./keychain.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
const openUrl = promisify(execFile);
const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version as string;
import { KeychainCredentialReader } from "./keychain.js";
import { resolveGlobalInvocation, resolveInvocation } from "./resolve.js";
import {
  canonicalizeCwd,
  findProject,
  readConfig,
  validateApiUrl
} from "./config.js";
import { hookCwd, readBoundedStdin, runHook } from "./hooks.js";
import {
  decideStop,
  renderStopDecision,
  watchForRewake,
  type StopOutput
} from "./stop-hooks.js";
import { runWakerCommand } from "./waker.js";
import { runDocumentCommand } from "./documents.js";
import { disconnectLocal, runDoctor, runStatus } from "./diagnostics.js";
import {
  finishSetup,
  isInteractive,
  startSetup,
  renderDetectedAgents,
  renderPreview,
  renderResult,
  renderSetupAuthorization,
  renderSetupResult,
  runSetupProgress,
  selectMcpScope,
  selectGlobalProjects,
  selectProject,
  selectHarnesses
} from "./ui.js";

export function parseInvocationArgs(argv: string[]): {
  command:
    | "status"
    | "mcp"
    | "setup"
    | "hook"
    | "doctor"
    | "disconnect"
    | "document"
    | "waker"
    | "version";
  integration?: ConfigurableIntegration | "all";
  waitBudgetSeconds?: number;
  watch?: boolean;
  autoContinue?: boolean;
  rewake?: boolean;
  wakerArgs?: string[];
  cwd?: string;
  global?: boolean;
  local?: boolean;
  event?: string;
  documentAction?:
    | "list"
    | "read"
    | "create"
    | "write"
    | "patch"
    | "history"
    | "upload"
    | "download";
  documentId?: string;
  attachmentId?: string;
  path?: string;
  limit?: number;
  cursor?: string;
  baseRevision?: number;
  resume?: string;
  includeArchived?: boolean;
} {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v"))
    return { command: "version" };
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      integration: { type: "string" },
      cwd: { type: "string" },
      global: { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      event: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      "base-revision": { type: "string" },
      resume: { type: "string" },
      "include-archived": { type: "boolean" },
      "wait-budget-seconds": { type: "string" },
      watch: { type: "boolean", default: false },
      "auto-continue": { type: "boolean", default: false },
      rewake: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false }
    },
    allowPositionals: true,
    strict: true
  });
  const documentCommand =
    positionals[0] === "document" || positionals[0] === "documents";
  if (
    (!documentCommand &&
      positionals.length !== 1 &&
      !(
        positionals.length === 2 &&
        (positionals[0] === "hook" ||
          positionals[0] === "disconnect" ||
          positionals[0] === "waker")
      )) ||
    (documentCommand && (positionals.length < 2 || positionals.length > 5)) ||
    (positionals[0] !== "status" &&
      positionals[0] !== "doctor" &&
      positionals[0] !== "disconnect" &&
      positionals[0] !== "hook" &&
      positionals[0] !== "mcp" &&
      positionals[0] !== "setup" &&
      positionals[0] !== "waker" &&
      positionals[0] !== "document" &&
      positionals[0] !== "documents")
  )
    usage();
  const integration = values.integration;
  if (values.local && positionals[0] !== "disconnect") usage();
  if (values.event !== undefined && positionals[0] !== "hook") usage();
  if (values.cwd !== undefined && positionals[0] !== "mcp") usage();
  if (values.global && positionals[0] !== "mcp") usage();
  if (values.global && values.cwd !== undefined) usage();
  if (values["wait-budget-seconds"] !== undefined && positionals[0] !== "mcp")
    usage();
  if (values.watch && positionals[0] !== "hook") usage();
  if ((values["auto-continue"] || values.rewake) && positionals[0] !== "setup")
    usage();
  if (values.rewake && !values["auto-continue"]) usage();
  if ((values.once || values["dry-run"]) && positionals[0] !== "waker") usage();
  if (
    typeof integration !== "undefined" &&
    !isConfigurableIntegration(integration)
  )
    usage();
  if (
    integration !== undefined &&
    positionals[0] !== "mcp" &&
    positionals[0] !== "document" &&
    positionals[0] !== "documents"
  )
    usage();
  if (positionals[0] === "document" || positionals[0] === "documents") {
    const action = positionals[1] as
      | "list"
      | "read"
      | "create"
      | "write"
      | "patch"
      | "history"
      | "upload"
      | "download";
    if (!integration || !isConfigurableIntegration(integration)) usage();
    if (
      !action ||
      ![
        "list",
        "read",
        "create",
        "write",
        "patch",
        "history",
        "upload",
        "download"
      ].includes(action)
    )
      usage();
    const documentId = action === "create" ? undefined : positionals[2];
    const path = action === "create" ? positionals[2] : positionals[3];
    if (["read", "write", "patch", "history"].includes(action) && !documentId)
      usage();
    if (action === "upload" && (!documentId || !path)) usage();
    if (action === "create" && !path) usage();
    const expectedPositionals = {
      list: 2,
      read: 3,
      create: 3,
      write: 3,
      patch: 3,
      history: 3,
      upload: 4,
      download: 5
    }[action];
    if (positionals.length !== expectedPositionals) usage();
    const limit = values.limit === undefined ? undefined : Number(values.limit);
    const baseRevision =
      values["base-revision"] === undefined
        ? undefined
        : Number(values["base-revision"]);
    if (
      limit !== undefined &&
      (!Number.isInteger(limit) || limit < 1 || limit > 100)
    )
      usage();
    if (
      baseRevision !== undefined &&
      (!Number.isInteger(baseRevision) || baseRevision < 1)
    )
      usage();
    if (values.limit !== undefined && !["list", "history"].includes(action))
      usage();
    if (values.cursor !== undefined && !["list", "history"].includes(action))
      usage();
    if (
      values["base-revision"] !== undefined &&
      !["write", "patch"].includes(action)
    )
      usage();
    if (values.resume !== undefined && action !== "upload") usage();
    if (values["include-archived"] && action !== "list") usage();
    return {
      command: "document",
      integration,
      documentAction: action,
      ...(documentId ? { documentId } : {}),
      ...(action === "download"
        ? { attachmentId: positionals[3], path: positionals[4] }
        : path
          ? { path }
          : {}),
      ...(limit === undefined ? {} : { limit }),
      ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
      ...(baseRevision === undefined ? {} : { baseRevision }),
      ...(values.resume === undefined ? {} : { resume: values.resume }),
      ...(values["include-archived"] ? { includeArchived: true } : {})
    };
  }
  if (positionals[0] === "setup")
    return {
      command: "setup",
      ...(values["auto-continue"] ? { autoContinue: true } : {}),
      ...(values.rewake ? { rewake: true } : {})
    };
  if (positionals[0] === "waker") {
    if (!["enable", "disable", "status", "run"].includes(positionals[1] ?? ""))
      usage();
    const index = argv.indexOf("waker");
    return {
      command: "waker",
      wakerArgs: argv.filter((_, position) => position !== index)
    };
  }
  if (positionals[0] === "hook") {
    const hookIntegration = positionals[1];
    if (
      positionals.length !== 2 ||
      !isConfigurableIntegration(hookIntegration) ||
      // OpenCode has no hooks; its plugin calls only the idle continuation.
      (hookIntegration === "opencode" && values.event !== "idle") ||
      (hookIntegration === "antigravity" &&
        !["PreInvocation", "Stop"].includes(values.event ?? "")) ||
      (hookIntegration === "cursor" &&
        values.event !== undefined &&
        !["sessionStart", "sessionEnd", "postToolUseFailure", "stop"].includes(
          values.event
        )) ||
      ((hookIntegration === "codex" || hookIntegration === "claude-code") &&
        values.event !== undefined &&
        values.event !== "Stop") ||
      (values.watch &&
        (hookIntegration !== "claude-code" || values.event !== "Stop"))
    )
      usage();
    return {
      command: "hook",
      integration: hookIntegration,
      event: values.event,
      ...(values.watch ? { watch: true } : {})
    };
  }
  if (positionals[0] === "doctor") return { command: "doctor" };
  if (positionals[0] === "disconnect") {
    if (!isConfigurableIntegration(positionals[1]) && positionals[1] !== "all")
      usage();
    return {
      command: "disconnect",
      integration: positionals[1] as ConfigurableIntegration | "all",
      local: values.local
    };
  }
  if (positionals[0] === "mcp" && integration === undefined) usage();
  const waitBudget =
    values["wait-budget-seconds"] === undefined
      ? undefined
      : Number(values["wait-budget-seconds"]);
  if (
    waitBudget !== undefined &&
    (!/^[0-9]+$/.test(values["wait-budget-seconds"]!) ||
      !Number.isInteger(waitBudget) ||
      waitBudget < 1 ||
      waitBudget > 3600)
  )
    usage();
  return integration === undefined
    ? { command: positionals[0] as "status" }
    : {
        command: positionals[0] as "mcp",
        integration,
        ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
        ...(values.global ? { global: true } : {}),
        ...(waitBudget === undefined ? {} : { waitBudgetSeconds: waitBudget })
      };
}

function usage(): never {
  throw new Error(
    "Usage: orchestrat setup [--auto-continue [--rewake]] | status | doctor | hook <integration> [--event <event>] | hook <claude-code|codex> --event Stop [--watch] | hook opencode --event idle | disconnect <integration|all> | mcp --integration <integration> [--cwd <project>] [--global] [--wait-budget-seconds <n>] | waker <enable|disable|status|run> [--once] [--dry-run] | document(s) <list|read|create|write|patch|history|upload|download> --integration <integration>"
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const {
    command,
    integration,
    local,
    event,
    cwd: configuredCwd,
    global,
    documentAction,
    documentId,
    attachmentId,
    path: documentPath,
    limit,
    cursor,
    baseRevision,
    resume,
    includeArchived,
    waitBudgetSeconds,
    watch,
    autoContinue,
    rewake,
    wakerArgs
  } = parseInvocationArgs(argv);
  if (command === "version") {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }
  const home = process.env.HOME ?? process.cwd();
  if (
    command === "hook" &&
    integration !== undefined &&
    integration !== "all" &&
    ((event === "Stop" &&
      (integration === "claude-code" || integration === "codex")) ||
      (integration === "opencode" && event === "idle"))
  ) {
    writeStopOutput(
      await runStopCommand({ integration, home, watch: watch === true })
    );
    return;
  }
  const interactive = isInteractive(process);
  const hookPayload = command === "hook" ? await readBoundedStdin() : undefined;
  const payloadCwd =
    command === "hook" && integration && integration !== "all"
      ? hookCwd(integration, hookPayload, process.cwd())
      : process.cwd();
  const config = await readConfig(home);
  const invocationCwd =
    command === "mcp" && configuredCwd ? resolve(configuredCwd) : payloadCwd;
  const project = findProject(config, invocationCwd);
  const api =
    validateApiUrl(process.env.ORCHESTRAT_API_URL) ??
    project?.apiUrl ??
    "https://api.orchestrat.dev";
  if (command === "document") {
    const resolved = await resolveInvocation({
      api,
      home,
      cwd: invocationCwd,
      integration: integration as ConfigurableIntegration,
      read: readConfig,
      credentials: new KeychainCredentialReader()
    });
    const client = new AgentApiClient({
      baseUrl: resolved.api!,
      token: resolved.credential!
    });
    const result = await runDocumentCommand({
      action: documentAction!,
      client,
      documentId,
      attachmentId,
      path: documentPath,
      limit,
      cursor,
      baseRevision,
      resume,
      includeArchived
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "waker") {
    process.exitCode = await runWakerCommand(wakerArgs ?? [], {
      home,
      cwd: process.cwd(),
      api,
      credentials: new KeychainCredentialReader()
    });
    return;
  }
  if (command === "hook") {
    if (!integration || integration === "all") usage();
    await runHook({
      integration,
      cwd: process.cwd(),
      home: process.env.HOME ?? process.cwd(),
      credentials: new KeychainCredentialReader(),
      payload: hookPayload,
      event,
      api
    });
    // Cursor `stop` and Antigravity `Stop` keep their lifecycle ingest and
    // add the opt-in continuation output in the same process (spec §11.2).
    const eventName =
      hookPayload && typeof hookPayload === "object"
        ? (hookPayload as Record<string, unknown>).hook_event_name
        : undefined;
    if (
      (integration === "cursor" &&
        (event === "stop" || eventName === "stop")) ||
      (integration === "antigravity" && event === "Stop")
    )
      writeStopOutput(
        renderStopDecision(
          integration,
          await decideStop({
            integration,
            payload: hookPayload,
            cwd: process.cwd(),
            home,
            api,
            credentials: new KeychainCredentialReader(),
            read: async () => config
          })
        )
      );
    return;
  }
  if (command === "doctor") {
    const result = await runDoctor({
      home,
      cwd: process.cwd(),
      credentials: new KeychainCredentialReader(),
      api,
      sourceCommand: resolve(process.argv[1] ?? "orchestrat")
    });
    renderResult("doctor", result, {
      interactive,
      write: (text) => process.stdout.write(text)
    });
    return;
  }
  if (command === "disconnect") {
    if (!integration) usage();
    const result = await disconnectLocal({
      home,
      cwd: process.cwd(),
      integration,
      store: new KeychainCredentialStore(),
      api,
      localOnly: local,
      fetch: globalThis.fetch,
      sourceCommand: resolve(process.argv[1] ?? "orchestrat"),
      reportPreview: async (previews) => {
        if (interactive)
          renderPreview(previews, (text) => process.stdout.write(text));
      }
    });
    renderResult(
      "disconnect",
      interactive ? { ...result, previews: [] } : result,
      {
        interactive,
        write: (text) => process.stdout.write(text)
      }
    );
    return;
  }
  if (command === "setup") {
    const store = new KeychainCredentialStore();
    const cwd = process.cwd();
    const existing = config.projects[canonicalizeCwd(cwd)];
    const authorization = interactive
      ? await (async () => {
          startSetup({ interactive });
          const result = await resolveSetupAuthorization(
            {
              api,
              fetch: globalThis.fetch,
              open: async (url) => {
                await openUrl("open", [url]);
              },
              sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
            },
            store,
            existing !== undefined && existing.apiUrl !== api
          );
          const selected = await selectProject(result.projects, {
            interactive
          });
          if (selected.cancelled) {
            process.exitCode = 130;
            return undefined;
          }
          renderSetupAuthorization(selected.value, { interactive });
          return { ...result, projectId: selected.value.id };
        })()
      : undefined;
    if (interactive && !authorization) return;
    const detected = await detectHarnesses();
    const detectedUi = detected.map((item) => ({
      id: item.id,
      label: item.label,
      configurable: item.configurable,
      hooksSupported: item.supportsHooks,
      unsupportedReason: item.configurable
        ? undefined
        : "built-in MCP configuration unavailable"
    }));
    if (interactive)
      renderDetectedAgents(detectedUi, {
        interactive,
        write: (text) => process.stdout.write(text)
      });
    const selected = await selectHarnesses(detectedUi, { interactive });
    if (selected.cancelled) {
      process.exitCode = 130;
      return;
    }
    const integrations = selected.values
      .map((item) => item.id)
      .filter(isConfigurableIntegration);
    if (!integrations.length)
      throw new Error("No configurable agent integrations found");
    const mcpScope = integrations.length
      ? await selectMcpScope({ interactive })
      : undefined;
    if (mcpScope?.cancelled) {
      process.exitCode = 130;
      return;
    }
    const globalProjects =
      mcpScope?.value === "global" && authorization
        ? await selectGlobalProjects(authorization.projects, { interactive })
        : undefined;
    if (globalProjects?.cancelled) {
      process.exitCode = 130;
      return;
    }
    const setupResult = await runSetupProgress(
      () =>
        runSetup({
          api,
          fetch: globalThis.fetch,
          open: async (url) => {
            await openUrl("open", [url]);
          },
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          store,
          cwd,
          home,
          integrations,
          authorization: authorization && {
            api: authorization.api,
            credential: authorization.credential,
            projects: authorization.projects
          },
          projectId: authorization?.projectId,
          mcpScope: mcpScope?.value,
          globalProjects: globalProjects?.values,
          sourceCommand: resolve(process.argv[1] ?? "orchestrat"),
          ...(autoContinue ? { autoContinue: true } : {}),
          ...(rewake ? { rewake: true } : {}),
          reportPreview: async (previews) => {
            if (interactive)
              renderPreview(
                previews.filter((item) => item.changed),
                (text) => process.stdout.write(text)
              );
          }
        }),
      { interactive }
    );
    const presentedResult = {
      ...setupResult,
      integrations: Object.fromEntries(
        integrations.map((id) => [id, setupResult.integrations[id]])
      ),
      harnesses: selected.values.map((item) => ({
        id: item.id,
        label: item.label,
        mcpConfigured: true,
        hooksSupported: item.hooksSupported,
        hooksConfigured: item.hooksSupported
      }))
    };
    if (interactive)
      for (const note of setupResult.notes ?? [])
        process.stdout.write(`${note}\n`);
    if (interactive) {
      renderSetupResult(presentedResult, (text) => process.stdout.write(text));
      finishSetup("Setup complete", { interactive });
    } else process.stdout.write(`${JSON.stringify(presentedResult)}\n`);
    return;
  }

  if (command === "status") {
    const result = await runStatus({
      home,
      cwd: process.cwd(),
      credentials: new KeychainCredentialReader(),
      api
    });
    renderResult("status", result, {
      interactive,
      write: (text) => process.stdout.write(text)
    });
  } else if (command === "mcp") {
    if (!integration || integration === "all") usage();
    if (global) {
      const projects = await resolveGlobalInvocation({
        api,
        integration,
        read: readConfig,
        credentials: new KeychainCredentialReader(),
        home,
        warn: (message) => process.stderr.write(message)
      });
      const { bridge } = await startStdioBridge({
        integration,
        ...(waitBudgetSeconds === undefined ? {} : { waitBudgetSeconds }),
        projects: projects.map((project) => ({
          id: project.projectId,
          name: `${project.organizationName} / ${project.name}`,
          client: new AgentApiClient({
            baseUrl: project.apiUrl,
            token: project.credential
          })
        }))
      });
      const shutdown = async () => {
        try {
          await bridge.stop();
        } catch (error) {
          process.stderr.write(
            `orchestrat: shutdown failed: ${error instanceof Error ? error.message : "unknown error"}\n`
          );
          process.exitCode = 1;
        }
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      return;
    }
    const resolved = await resolveInvocation({
      api,
      home,
      cwd: invocationCwd,
      integration,
      read: readConfig,
      credentials: new KeychainCredentialReader()
    });
    const publicResult = resolved.public as {
      integration: string;
      projectId: string;
    };
    const client = new AgentApiClient({
      baseUrl: resolved.api!,
      token: resolved.credential!
    });
    const { bridge } = await startStdioBridge({
      client,
      integration: publicResult.integration as ConfigurableIntegration,
      ...(waitBudgetSeconds === undefined ? {} : { waitBudgetSeconds })
    });
    const shutdown = async () => {
      try {
        await bridge.stop();
      } catch (error) {
        process.stderr.write(
          `orchestrat: shutdown failed: ${error instanceof Error ? error.message : "unknown error"}\n`
        );
        process.exitCode = 1;
      }
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}

// Stop continuation must never break the harness: any failure, including a
// malformed payload or config, renders as "allow the stop".
async function runStopCommand(input: {
  integration: ConfigurableIntegration;
  home: string;
  watch: boolean;
}): Promise<StopOutput> {
  try {
    const payload = await readBoundedStdin();
    const payloadCwd = hookCwd(input.integration, payload, process.cwd());
    const config = await readConfig(input.home);
    const api =
      validateApiUrl(process.env.ORCHESTRAT_API_URL) ??
      findProject(config, payloadCwd)?.apiUrl ??
      "https://api.orchestrat.dev";
    const options = {
      integration: input.integration,
      payload,
      cwd: process.cwd(),
      home: input.home,
      api,
      credentials: new KeychainCredentialReader(),
      read: async () => config
    };
    return renderStopDecision(
      input.integration,
      input.watch ? await watchForRewake(options) : await decideStop(options)
    );
  } catch {
    return renderStopDecision(input.integration, {
      continue: false,
      why: "failed open"
    });
  }
}

function writeStopOutput(output: StopOutput) {
  if (output.stdout) process.stdout.write(output.stdout);
  if (output.stderr) process.stderr.write(output.stderr);
  if (output.exitCode) process.exitCode = output.exitCode;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((error: Error) => {
    process.stderr.write(`orchestrat: ${error.message}\n`);
    process.exitCode = 1;
  });
}
