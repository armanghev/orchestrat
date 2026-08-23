#!/usr/bin/env node

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { AgentApiClient } from "@orchestrat/sdk";
import { startStdioBridge } from "@orchestrat/mcp";
import { readConfig } from "./config.js";
import { detectIntegrations, runSetup } from "./setup.js";
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

export function parseInvocationArgs(argv: string[]): {
  command:
    "status" | "mcp" | "setup" | "hook" | "doctor" | "disconnect" | "version";
  integration?: "codex" | "claude-code" | "all";
  local?: boolean;
} {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v"))
    return { command: "version" };
  const { positionals, values } = parseArgs({
    args: argv,
    options: {
      integration: { type: "string" },
      local: { type: "boolean", default: false }
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
    integration !== "codex" &&
    integration !== "claude-code"
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
      (hookIntegration !== "codex" && hookIntegration !== "claude-code")
    )
      usage();
    return { command: "hook", integration: hookIntegration };
  }
  if (positionals[0] === "doctor") return { command: "doctor" };
  if (positionals[0] === "disconnect") {
    if (
      positionals[1] !== "codex" &&
      positionals[1] !== "claude-code" &&
      positionals[1] !== "all"
    )
      usage();
    return {
      command: "disconnect",
      integration: positionals[1],
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
    "Usage: orchestrat setup | status | doctor | hook <codex|claude-code> | disconnect <codex|claude-code|all> | mcp --integration <codex|claude-code>"
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, integration, local } = parseInvocationArgs(argv);
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
    await runHook({
      integration: integration as "codex" | "claude-code",
      cwd: process.cwd(),
      home: process.env.HOME ?? process.cwd(),
      credentials: new KeychainCredentialReader(),
      payload: hookPayload,
      api
    });
    return;
  }
  if (command === "doctor") {
    process.stdout.write(
      `${JSON.stringify(
        await runDoctor({
          home,
          cwd: process.cwd(),
          credentials: new KeychainCredentialReader(),
          api,
          sourceCommand: resolve(process.argv[1] ?? "orchestrat")
        })
      )}\n`
    );
    return;
  }
  if (command === "disconnect") {
    if (
      integration !== "codex" &&
      integration !== "claude-code" &&
      integration !== "all"
    )
      usage();
    process.stdout.write(
      `${JSON.stringify(
        await disconnectLocal({
          home,
          cwd: process.cwd(),
          integration,
          store: new KeychainCredentialStore(),
          api,
          localOnly: local,
          fetch: globalThis.fetch,
          sourceCommand: resolve(process.argv[1] ?? "orchestrat"),
          reportPreview: async (previews) => {
            for (const preview of previews)
              process.stdout.write(
                `orchestrat: preview ${preview.path} ${(preview.entries ?? []).join(",")}\n`
              );
          }
        })
      )}\n`
    );
    return;
  }
  if (command === "setup") {
    const integrations = await detectIntegrations();
    const setupResult = await runSetup({
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
        for (const preview of previews.filter((item) => item.changed))
          process.stdout.write(
            `orchestrat: preview ${preview.path} ${(preview.entries ?? []).join(",")}\n`
          );
      }
    });
    for (const [integration, value] of Object.entries(setupResult.integrations))
      process.stdout.write(
        `orchestrat: connected ${integration} (${value.agentId})\n`
      );
    if (setupResult.pathFix)
      process.stdout.write(
        `orchestrat: add the launcher to PATH with: ${setupResult.pathFix}\n`
      );
    return;
  }

  const resolved = await resolveInvocation({
    cwd: process.cwd(),
    integration: integration as "codex" | "claude-code" | undefined,
    read: readConfig,
    credentials: new KeychainCredentialReader()
  });
  if (command === "status") {
    process.stdout.write(
      `${JSON.stringify(
        await runStatus({
          home,
          cwd: process.cwd(),
          credentials: new KeychainCredentialReader(),
          api
        })
      )}\n`
    );
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
