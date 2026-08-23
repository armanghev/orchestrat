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
import { readBoundedStdin, runHook } from "./hooks.js";
import { disconnectLocal, runDoctor, runStatus } from "./diagnostics.js";

export function parseInvocationArgs(argv: string[]): {
  command: "status" | "mcp" | "setup" | "hook" | "doctor" | "disconnect";
  integration?: "codex" | "claude-code" | "all";
} {
  const { positionals, values } = parseArgs({
    args: argv,
    options: { integration: { type: "string" } },
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
    return { command: "disconnect", integration: positionals[1] };
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
  const { command, integration } = parseInvocationArgs(argv);
  if (command === "hook") {
    const payload = await readBoundedStdin();
    await runHook({
      integration: integration as "codex" | "claude-code",
      cwd: process.cwd(),
      home: process.env.HOME ?? process.cwd(),
      credentials: new KeychainCredentialReader(),
      payload,
      api: process.env.ORCHESTRAT_API_URL ?? "https://api.orchestrat.dev"
    });
    return;
  }
  const home = process.env.HOME ?? process.cwd();
  if (command === "doctor") {
    process.stdout.write(
      `${JSON.stringify(
        await runDoctor({
          home,
          cwd: process.cwd(),
          credentials: new KeychainCredentialReader(),
          api: process.env.ORCHESTRAT_API_URL ?? "https://api.orchestrat.dev",
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
          api: process.env.ORCHESTRAT_API_URL ?? "https://api.orchestrat.dev",
          fetch: globalThis.fetch,
          sourceCommand: resolve(process.argv[1] ?? "orchestrat")
        })
      )}\n`
    );
    return;
  }
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
          api: process.env.ORCHESTRAT_API_URL ?? "https://api.orchestrat.dev"
        })
      )}\n`
    );
  } else if (command === "mcp") {
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
