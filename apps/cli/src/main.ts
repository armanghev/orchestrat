#!/usr/bin/env node

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { AgentApiClient } from "@orchestrat/sdk";
import { startStdioBridge } from "@orchestrat/mcp";
import { readConfig } from "./config.js";
import { detectIntegrations, runSetup } from "./setup.js";
import { KeychainCredentialStore } from "./keychain.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
const openUrl = promisify(execFile);
import { KeychainCredentialReader } from "./keychain.js";
import { resolveInvocation } from "./resolve.js";

export function parseInvocationArgs(argv: string[]): {
  command: "status" | "mcp" | "setup";
  integration?: "codex" | "claude-code";
} {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { integration: { type: "string" } },
    allowPositionals: true,
    strict: true
  });
  if (
    positionals.length !== 1 ||
    (positionals[0] !== "status" &&
      positionals[0] !== "mcp" &&
      positionals[0] !== "setup")
  )
    usage();
  const integration = values.integration;
  if (
    typeof integration !== "undefined" &&
    integration !== "codex" &&
    integration !== "claude-code"
  )
    usage();
  if (
    (positionals[0] === "status" || positionals[0] === "setup") &&
    integration !== undefined
  )
    usage();
  if (positionals[0] === "setup") return { command: "setup" };
  if (positionals[0] === "mcp" && integration === undefined) usage();
  return integration === undefined
    ? { command: positionals[0] as "status" }
    : { command: positionals[0] as "mcp", integration };
}

function usage(): never {
  throw new Error(
    "Usage: orchestrat setup | orchestrat status | orchestrat mcp --integration <codex|claude-code>"
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, integration } = parseInvocationArgs(argv);
  if (command === "setup") {
    const integrations = await detectIntegrations();
    const setupResult = await runSetup({
      api: process.env.ORCHESTRAT_API_URL ?? "https://api.orchestrat.dev",
      fetch: globalThis.fetch,
      open: async (url) => {
        await openUrl("open", [url]);
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      store: new KeychainCredentialStore(),
      cwd: process.cwd(),
      home: process.env.HOME ?? process.cwd(),
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
    return;
  }

  const resolved = await resolveInvocation({
    cwd: process.cwd(),
    integration,
    read: readConfig,
    credentials: new KeychainCredentialReader()
  });
  if (command === "status")
    process.stdout.write(
      `${JSON.stringify({ command, ...resolved.public })}\n`
    );
  else {
    const publicResult = resolved.public as {
      integration: string;
      projectId: string;
    };
    const client = new AgentApiClient({
      baseUrl: process.env.ORCHESTRAT_API_URL ?? "https://api.orchestrat.dev",
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
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: Error) => {
    process.stderr.write(`orchestrat: ${error.message}\n`);
    process.exitCode = 1;
  });
}
