#!/usr/bin/env node

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { AgentApiClient } from "@orchestrat/sdk";
import { startStdioBridge } from "@orchestrat/mcp";
import { detectHarnesses, runSetup } from "./setup.js";
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
import { resolveInvocation } from "./resolve.js";
import { findProject, readConfig, validateApiUrl } from "./config.js";
import { hookCwd, readBoundedStdin, runHook } from "./hooks.js";
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
  if (values.event !== undefined && positionals[0] !== "hook") usage();
  if (
    typeof integration !== "undefined" &&
    !isConfigurableIntegration(integration)
  )
    usage();
  if (integration !== undefined && positionals[0] !== "mcp") usage();
  if (positionals[0] === "setup") return { command: "setup" };
  if (positionals[0] === "hook") {
    const hookIntegration = positionals[1];
    if (
      positionals.length !== 2 ||
      !isConfigurableIntegration(hookIntegration) ||
      hookIntegration === "opencode" ||
      (hookIntegration === "antigravity" &&
        !["PreInvocation", "Stop"].includes(values.event ?? "")) ||
      (hookIntegration === "cursor" &&
        values.event !== undefined &&
        !["sessionStart", "sessionEnd", "postToolUseFailure"].includes(
          values.event
        )) ||
      ((hookIntegration === "codex" || hookIntegration === "claude-code") &&
        values.event !== undefined)
    )
      usage();
    return {
      command: "hook",
      integration: hookIntegration,
      event: values.event
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
  const interactive = isInteractive(process);
  const hookPayload = command === "hook" ? await readBoundedStdin() : undefined;
  const payloadCwd =
    command === "hook" && integration && integration !== "all"
      ? hookCwd(integration, hookPayload, process.cwd())
      : process.cwd();
  const project = findProject(await readConfig(home), payloadCwd);
  const api =
    validateApiUrl(process.env.ORCHESTRAT_API_URL) ??
    project?.apiUrl ??
    "https://api.orchestrat.dev";
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
    const setupResult = await runSetupProgress(
      () =>
        runSetup({
          api,
          fetch: globalThis.fetch,
          open: async (url) => {
            await openUrl("open", [url]);
          },
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          store: new KeychainCredentialStore(),
          cwd: process.cwd(),
          home,
          integrations,
          sourceCommand: resolve(process.argv[1] ?? "orchestrat"),
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
    const resolved = await resolveInvocation({
      cwd: process.cwd(),
      integration,
      read: readConfig,
      credentials: new KeychainCredentialReader()
    });
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
      integration: publicResult.integration as ConfigurableIntegration
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
