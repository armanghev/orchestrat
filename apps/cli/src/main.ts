#!/usr/bin/env node

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { AgentApiClient } from "@orchestrat/sdk";
import { startStdioBridge } from "@orchestrat/mcp";
import { readConfig } from "./config.js";
import { detectHarnesses, runSetup } from "./setup.js";
import { isConfigurableIntegration, type ConfigurableIntegration } from "./harnesses.js";
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
import { resolveInvocation } from "./resolve.js";
import { findProject, validateApiUrl } from "./config.js";
import { readBoundedStdin, runHook } from "./hooks.js";
import { disconnectLocal, runDoctor, runStatus } from "./diagnostics.js";
import {
  finishSetup,
  isInteractive,
  renderDetectedAgents,
  renderPreview,
  renderResult,
  renderSetupResult,
  runSetupProgress,
  selectHarnesses
} from "./ui.js";

export function parseInvocationArgs(argv: string[]): {
  command:
    "status" | "mcp" | "setup" | "hook" | "doctor" | "disconnect" | "version";
  integration?: ConfigurableIntegration | "all";
  local?: boolean;
  event?: string;
} {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v"))
    return { command: "version" };
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      integration: { type: "string" },
      local: { type: "boolean", default: false },
      event: { type: "string" }
    },
    allowPositionals: true,
    strict: true
  });
  if (
    (positionals.length !== 1 &&
      !(
        positionals.length === 2 &&
        (positionals[0] === "hook" || positionals[0] === "disconnect")
      )) ||
    (positionals[0] !== "status" &&
      positionals[0] !== "doctor" &&
      positionals[0] !== "disconnect" &&
      positionals[0] !== "hook" &&
      positionals[0] !== "mcp" &&
      positionals[0] !== "setup")
  )
    usage();
  const integration = values.integration;
  if (values.local && positionals[0] !== "disconnect") usage();
  if (
    typeof integration !== "undefined" &&
    !isConfigurableIntegration(integration)
  )
    usage();
  if (
    (positionals[0] === "status" ||
      positionals[0] === "setup" ||
      positionals[0] === "doctor") &&
    integration !== undefined
  )
    usage();
  if (positionals[0] === "setup") return { command: "setup" };
  if (positionals[0] === "hook") {
    const hookIntegration = positionals[1];
    if (
      positionals.length !== 2 ||
      !isConfigurableIntegration(hookIntegration) ||
      ((hookIntegration === "cursor" || hookIntegration === "antigravity") &&
        typeof values.event !== "string")
    )
      usage();
    return { command: "hook", integration: hookIntegration, event: values.event };
  }
  if (positionals[0] === "doctor") return { command: "doctor" };
  if (positionals[0] === "disconnect") {
    if (
      !isConfigurableIntegration(positionals[1]) &&
      positionals[1] !== "all"
    )
      usage();
    return {
      command: "disconnect",
      integration: positionals[1] as ConfigurableIntegration | "all",
      local: values.local
    };
  }
  if (positionals[0] === "mcp" && integration === undefined) usage();
  return integration === undefined
    ? { command: positionals[0] as "status" }
    : { command: positionals[0] as "mcp", integration };
}

function usage(): never {
  throw new Error(
    "Usage: orchestrat setup | status | doctor | hook <integration> [--event <event>] | disconnect <integration|all> | mcp --integration <integration>"
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, integration, local, event } = parseInvocationArgs(argv);
  if (command === "version") {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }
  const home = process.env.HOME ?? process.cwd();
  const hookPayload = command === "hook" ? await readBoundedStdin() : undefined;
  const payloadCwd =
    hookPayload &&
    typeof hookPayload === "object" &&
    typeof (hookPayload as { cwd?: unknown }).cwd === "string"
      ? (hookPayload as { cwd: string }).cwd
      : process.cwd();
  const project = findProject(await readConfig(home), payloadCwd);
  const api =
    validateApiUrl(process.env.ORCHESTRAT_API_URL) ??
    project?.apiUrl ??
    "https://api.orchestrat.dev";
  if (command === "hook") {
    if (integration !== "codex" && integration !== "claude-code")
      throw new Error(`${integration} hooks require a future hook adapter (event: ${event})`);
    await runHook({
      integration,
      cwd: process.cwd(),
      home: process.env.HOME ?? process.cwd(),
      credentials: new KeychainCredentialReader(),
      payload: hookPayload,
      api
    });
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
    renderResult("doctor", result, { interactive: isInteractive(process), write: (text) => process.stdout.write(text) });
    return;
  }
  if (command === "disconnect") {
    if (!integration)
      usage();
    const result = await disconnectLocal({
          home,
          cwd: process.cwd(),
          integration: integration as never,
          store: new KeychainCredentialStore(),
          api,
          localOnly: local,
          fetch: globalThis.fetch,
          sourceCommand: resolve(process.argv[1] ?? "orchestrat"),
          reportPreview: async (previews) => {
            if (isInteractive(process)) renderPreview(previews, (text) => process.stdout.write(text));
          }
        });
    renderResult("disconnect", result, { interactive: isInteractive(process), write: (text) => process.stdout.write(text) });
    return;
  }
  if (command === "setup") {
    const interactive = isInteractive(process);
    const detected = await detectHarnesses();
    const detectedUi = detected.map((item) => ({
      id: item.id,
      label: item.label,
      configurable: item.configurable,
      mcpConfigured: item.supportsMcp,
      hooksSupported: item.supportsHooks,
      hooksConfigured: item.supportsHooks,
      unsupportedReason: item.configurable ? undefined : "not configurable"
    }));
    if (interactive) renderDetectedAgents(detectedUi, { interactive, write: (text) => process.stdout.write(text) });
    const selected = await selectHarnesses(detectedUi, { interactive });
    if (selected.cancelled) {
      process.exitCode = 130;
      return;
    }
    const integrations = selected.values.map((item) => item.id).filter(isConfigurableIntegration);
    const setupResult = await runSetupProgress(() => runSetup({
      api,
      fetch: globalThis.fetch,
      open: async (url) => {
        await openUrl("open", [url]);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      store: new KeychainCredentialStore(),
      cwd: process.cwd(),
      home,
      integrations: integrations as never,
      sourceCommand: resolve(process.argv[1] ?? "orchestrat"),
      reportPreview: async (previews) => {
        if (interactive) renderPreview(previews.filter((item) => item.changed), (text) => process.stdout.write(text));
      }
    }), { interactive });
    const presentedResult = {
      ...setupResult,
      harnesses: selected.values.map((item) => ({
        id: item.id,
        label: item.label,
        mcpConfigured: item.mcpConfigured,
        hooksSupported: item.hooksSupported,
        hooksConfigured: item.hooksConfigured
      }))
    };
    if (interactive) {
      renderSetupResult(presentedResult, (text) => process.stdout.write(text));
      finishSetup("Setup complete", { interactive });
    } else process.stdout.write(`${JSON.stringify(presentedResult)}\n`);
    return;
  }

  const resolved = await resolveInvocation({
    cwd: process.cwd(),
    integration: integration as "codex" | "claude-code" | undefined,
    read: readConfig,
    credentials: new KeychainCredentialReader()
  });
  if (command === "status") {
    const result = await runStatus({
      home,
      cwd: process.cwd(),
      credentials: new KeychainCredentialReader(),
      api
    });
    renderResult("status", result, { interactive: isInteractive(process), write: (text) => process.stdout.write(text) });
  } else if (command === "mcp") {
    const publicResult = resolved.public as {
      integration: string;
      projectId: string;
    };
    const client = new AgentApiClient({
      baseUrl: api,
      token: resolved.credential!
    });
    const { bridge } = await startStdioBridge({
      client,
      integration: publicResult.integration as "codex" | "claude-code"
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

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((error: Error) => {
    process.stderr.write(`orchestrat: ${error.message}\n`);
    process.exitCode = 1;
  });
}
