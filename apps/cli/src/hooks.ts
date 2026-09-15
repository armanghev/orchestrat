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

export function hookCwd(
  integration: ConfigurableIntegration,
  payload: unknown,
  fallback: string
) {
  if (!payload || typeof payload !== "object") return fallback;
  const input = payload as Record<string, unknown>;
  if (typeof input.cwd === "string") return input.cwd;
  const paths =
    integration === "cursor"
      ? input.workspace_roots
      : integration === "antigravity"
        ? input.workspacePaths
        : undefined;
  return Array.isArray(paths) && typeof paths[0] === "string"
    ? paths[0]
    : fallback;
}

export async function readBoundedStdin(
  stdin: AsyncIterable<Buffer | string> = process.stdin,
  ceiling = 64 * 1024,
  errorMessage = "Hook input exceeds 64 KiB"
) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > ceiling) throw new Error(errorMessage);
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
  const payloadCwd = hookCwd(input.integration, input.payload, input.cwd);
  const resolved = await resolveInvocation({
    api: input.api,
    cwd: payloadCwd,
    home: input.home,
    integration: input.integration,
    read: input.read ?? (() => readConfig(input.home)),
    credentials: input.credentials
  });
  const client = new AgentApiClient({
    baseUrl: resolved.api!,
    token: resolved.credential!,
    fetch: input.fetch
  });
  const idempotencyKey = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  return client.ingestLifecycle(normalized, idempotencyKey);
}
