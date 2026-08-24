import { deterministicSessionId, type NormalizedHook } from "./hook-types.js";

const errorText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.slice(0, 2000) : undefined;

export function normalizeCursorHook(value: unknown): NormalizedHook {
  if (!value || typeof value !== "object")
    throw new Error("Malformed Cursor hook input");
  const input = value as Record<string, unknown>;
  const eventName = input.hook_event_name;
  if (typeof eventName !== "string")
    throw new Error("Malformed Cursor hook input");
  const external =
    typeof input.conversation_id === "string"
      ? input.conversation_id.trim()
      : "";
  if (!external) throw new Error("Missing Cursor conversation_id");
  const roots = input.workspace_roots;
  const root = Array.isArray(roots) ? roots[0] : undefined;
  const cwd =
    typeof input.cwd === "string" && input.cwd.trim()
      ? input.cwd.trim()
      : typeof root === "string" && root.trim()
        ? root.trim()
        : "";
  if (!cwd) throw new Error("Missing Cursor cwd");
  const event =
    eventName === "sessionStart"
      ? "session.started"
      : eventName === "sessionEnd" || eventName === "stop"
        ? "session.ended"
        : eventName === "postToolUseFailure"
          ? "run.failed"
          : undefined;
  if (!event) throw new Error("Unsupported Cursor hook event");
  const error = errorText(
    input.error_message ?? input.error ?? input.tool_output ?? input.reason
  );
  return {
    event,
    session_id: deterministicSessionId("cursor", external),
    external_session_id: external,
    runtime: "cursor",
    integration: "cursor",
    ...(error ? { error } : {})
  };
}
