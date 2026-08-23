import { deterministicSessionId, type NormalizedHook } from "./hook-types.js";

export function normalizeCodexHook(value: unknown): NormalizedHook {
  const input = value as Record<string, unknown>;
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.hook_event_name !== "string" ||
    typeof input.cwd !== "string" ||
    !input.cwd.trim()
  )
    throw new Error("Malformed Codex hook input");
  const event = (
    {
      SessionStart: "session.started",
      SessionEnd: "session.ended"
    } as Record<string, NormalizedHook["event"]>
  )[input.hook_event_name];
  if (!event) throw new Error("Unsupported Codex hook event");
  const external =
    typeof input.session_id === "string" ? input.session_id.trim() : "";
  if (!external) throw new Error("Missing Codex session_id");
  return {
    event,
    session_id: deterministicSessionId("codex", external),
    external_session_id: external,
    runtime: "codex",
    integration: "codex"
  };
}
