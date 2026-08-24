import { createHash } from "node:crypto";
import { readConfig, type OrchestratConfig } from "./config.js";
import { resolveInvocation } from "./resolve.js";
import type { CredentialReader } from "./keychain.js";
import { AgentApiClient } from "@orchestrat/sdk";
import { normalizeCodexHook } from "./codex-hooks.js";
import { normalizeClaudeHook } from "./claude-hooks.js";
import { normalizeCursorHook } from "./cursor-hooks.js";
import { normalizeAntigravityHook } from "./antigravity-hooks.js";
import type { ConfigurableIntegration } from "./harnesses.js";
export type { NormalizedHook } from "./hook-types.js";
export { deterministicSessionId } from "./hook-types.js";

export async function readBoundedStdin(
  stdin: AsyncIterable<Buffer | string> = process.stdin,
  ceiling = 64 * 1024
) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > ceiling) throw new Error("Hook input exceeds 64 KiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function runHook(input: {
  integration: ConfigurableIntegration;
  cwd: string;
  home: string;
  read?: () => Promise<OrchestratConfig>;
  credentials: CredentialReader;
  payload: unknown;
  event?: string;
  eventName?: string;
  api: string;
  fetch?: typeof globalThis.fetch;
}) {
  if (input.integration === "opencode")
    throw new Error("OpenCode does not support hooks");
  const normalized =
    input.integration === "codex"
      ? normalizeCodexHook(input.payload)
      : input.integration === "claude-code"
        ? normalizeClaudeHook(input.payload)
        : input.integration === "cursor"
          ? normalizeCursorHook(input.payload)
          : normalizeAntigravityHook(
              input.event ?? input.eventName,
              input.payload
            );
  const payloadCwd =
    input.payload &&
    typeof input.payload === "object" &&
    typeof (input.payload as { cwd?: unknown }).cwd === "string"
      ? (input.payload as { cwd: string }).cwd
      : input.integration === "cursor" &&
          Array.isArray((input.payload as { workspace_roots?: unknown })?.workspace_roots) &&
          typeof (input.payload as { workspace_roots: unknown[] }).workspace_roots[0] === "string"
        ? (input.payload as { workspace_roots: string[] }).workspace_roots[0]
        : input.integration === "antigravity" &&
            Array.isArray((input.payload as { workspacePaths?: unknown })?.workspacePaths) &&
            typeof (input.payload as { workspacePaths: unknown[] }).workspacePaths[0] === "string"
          ? (input.payload as { workspacePaths: string[] }).workspacePaths[0]
          : input.cwd;
  const resolved = await resolveInvocation({
    cwd: payloadCwd,
    home: input.home,
    integration: input.integration,
    read: input.read ?? (() => readConfig(input.home)),
    credentials: input.credentials
  });
  const client = new AgentApiClient({
    baseUrl: input.api,
    token: resolved.credential!,
    fetch: input.fetch
  });
  const idempotencyKey = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  return client.ingestLifecycle(normalized, idempotencyKey);
}
