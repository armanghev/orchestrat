import { deterministicSessionId, type NormalizedHook } from "./hook-types.js";

export function normalizeClaudeHook(value: unknown): NormalizedHook {
  const input = value as Record<string, unknown>;
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.hook_event_name !== "string" ||
    typeof input.cwd !== "string" ||
    !input.cwd.trim()
  )
    throw new Error("Malformed Claude hook input");
  const event = (
    {
      SessionStart: "session.started",
      SessionEnd: "session.ended",
      StopFailure: "run.failed"
    } as Record<string, NormalizedHook["event"]>
  )[input.hook_event_name];
  if (!event) throw new Error("Unsupported Claude hook event");
  const external =
    typeof input.session_id === "string" ? input.session_id.trim() : "";
  if (!external) throw new Error("Missing Claude session_id");
  return {
    event,
    session_id: deterministicSessionId("claude-code", external),
    external_session_id: external,
    runtime: "claude",
    integration: "claude-code",
    ...(typeof input.error === "string"
      ? { error: input.error.slice(0, 2000) }
      : {})
  };
}
