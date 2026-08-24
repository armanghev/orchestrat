import { deterministicSessionId, type NormalizedHook } from "./hook-types.js";

const errorText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.slice(0, 2000) : undefined;

export function normalizeAntigravityHook(
  eventName: unknown,
  value: unknown
): NormalizedHook {
  if (!value || typeof value !== "object" || typeof eventName !== "string")
    throw new Error("Malformed Antigravity hook input");
  const input = value as Record<string, unknown>;
  const external =
    typeof input.conversationId === "string" ? input.conversationId.trim() : "";
  if (!external) throw new Error("Missing Antigravity conversationId");
  const paths = input.workspacePaths;
  const cwd = Array.isArray(paths) && typeof paths[0] === "string" ? paths[0].trim() : "";
  if (!cwd) throw new Error("Missing Antigravity workspace path");
  if (eventName !== "PreInvocation" && eventName !== "Stop")
    throw new Error("Unsupported Antigravity hook event");
  const error = errorText(input.error);
  const failed = eventName === "Stop" && !!error;
  return {
    event: failed ? "run.failed" : eventName === "PreInvocation" ? "session.started" : "session.ended",
    session_id: deterministicSessionId("antigravity", external),
    external_session_id: external,
    runtime: "antigravity",
    integration: "antigravity",
    ...(error ? { error } : {})
  };
}
