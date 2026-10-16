import { createHash } from "node:crypto";

export type NormalizedHook = {
  event: "session.started" | "session.ended" | "run.failed";
  session_id: string;
  external_session_id: string;
  runtime: string;
  integration: "codex" | "claude-code" | "cursor" | "antigravity";
  error?: string;
};

// With a branch, the branch is part of the id: one conversation gets one
// session per branch, and hook idempotency keys stay unique per branch. Without
// one, the id is the pre-branches formula.
export const deterministicSessionId = (
  integration: string,
  external: string,
  branchId?: string
) => {
  const hex = createHash("sha256")
    .update(
      branchId
        ? `${integration}\0${external}\0${branchId}`
        : `${integration}\0${external}`
    )
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
};

// The harness's own session id, read the same way the lifecycle normalizers
// read it: Claude/Codex `session_id`, Cursor `conversation_id`,
// Antigravity `conversationId`.
export function externalSessionId(
  integration: string,
  value: unknown
): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const raw =
    integration === "cursor"
      ? input.conversation_id
      : integration === "antigravity"
        ? input.conversationId
        : input.session_id;
  const external = typeof raw === "string" ? raw.trim() : "";
  return external ? external.slice(0, 256) : undefined;
}
