import { createHash } from "node:crypto";
import { readConfig, type OrchestratConfig } from "./config.js";
import { resolveInvocation } from "./resolve.js";
import type { CredentialReader } from "./keychain.js";
import { AgentApiClient } from "@orchestrat/sdk";
import { normalizeCodexHook } from "./codex-hooks.js";
import { normalizeClaudeHook } from "./claude-hooks.js";
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
  integration: "codex" | "claude-code";
  cwd: string;
  home: string;
  read?: () => Promise<OrchestratConfig>;
  credentials: CredentialReader;
  payload: unknown;
  api: string;
  fetch?: typeof globalThis.fetch;
}) {
  const normalized =
    input.integration === "codex"
      ? normalizeCodexHook(input.payload)
      : normalizeClaudeHook(input.payload);
  const payloadCwd =
    input.payload &&
    typeof input.payload === "object" &&
    typeof (input.payload as { cwd?: unknown }).cwd === "string"
      ? (input.payload as { cwd: string }).cwd
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
