import type { ProjectEvent } from "@orchestrat/protocol";

type ActivityPayload = ProjectEvent["payload"];
type ParticipantRef = { type: "human" | "agent"; id: string };

const statusLabel = (value: unknown) =>
  typeof value === "string" ? value.replaceAll("_", " ") : "a new status";

// Why a blocker closed. Resolutions run inside the causing actor's change, so
// the actor line stays truthful and this only names the cause (spec §15).
const blockResolutionCopy: Record<string, string> = {
  blocking_task_done: " after its blocking task was done",
  blocking_task_cancelled: " after its blocking task was cancelled",
  participant_responded: " by responding",
  status_changed: " by changing its status",
  moved_by_human: " by moving it",
  released: " by releasing it"
};

export function activityVerb(type: string, payload: ActivityPayload = {}) {
  if (type === "task.status_changed") {
    const to = payload.to_status;
    if (to === "blocked") return "is blocked on";
    if (to === "review") return "submitted";
    if (to === "in_progress")
      return payload.from_status === "blocked"
        ? "resumed work on"
        : "started work on";
    return "moved";
  }
  if (type === "run.woken")
    return payload.handoff_id
      ? "was woken for a handoff"
      : "was woken by the local waker";
  const verbs: Record<string, string> = {
    "task.created": "created",
    "task.updated": "updated",
    "task.moved": "moved",
    "task.comment_created": "commented on",
    "task.dependency_added": "added a dependency to",
    "task.dependency_removed": "removed a dependency from",
    "task.block_resolved": "resolved the blocker on",
    "task.done": "completed",
    "document.created": "created",
    "document.updated": "updated",
    "agent.created": "connected",
    "agent.revoked": "revoked",
    "claim.created": "claimed",
    "claim.completed": "completed",
    "claim.expired": "expired the claim on",
    "claim.revoked": "released",
    "chat.handoff_created": "handed off",
    "session.opened": "opened a session",
    "session.closed": "closed a session",
    "session.started": "started a session",
    "session.ended": "ended a session",
    "session.stopped": "stopped a session",
    "session.heartbeat": "reported a heartbeat",
    "credential.issued": "issued a credential",
    "credential.revoked": "revoked a credential",
    "hook.triggered": "triggered a hook",
    "run.failed": "reported a failed run"
  };
  const [entity, action] = type.split(".");
  return (
    verbs[type] ??
    (["task", "document"].includes(entity) && action
      ? action.replaceAll("_", " ")
      : type.replace(/[._]/g, " "))
  );
}

/**
 * Text after the event's target, e.g. "moved ORC-3 *to ready*" or "handed off
 * ORC-3 *to codex*". `nameOf` resolves participants the viewer can see.
 */
export function activitySuffix(
  event: Pick<ProjectEvent, "type" | "payload">,
  nameOf: (participant: ParticipantRef) => string | undefined = () => undefined
) {
  const { payload } = event;
  switch (event.type) {
    case "task.status_changed": {
      const to = payload.to_status;
      if (to === "review") return " for review";
      if (to === "blocked" || to === "in_progress") return "";
      return ` to ${statusLabel(to)}`;
    }
    case "task.block_resolved":
      return typeof payload.resolution === "string"
        ? (blockResolutionCopy[payload.resolution] ?? "")
        : "";
    case "chat.handoff_created": {
      const participant = payload.participant as
        Partial<ParticipantRef> | undefined;
      const name =
        participant &&
        (participant.type === "human" || participant.type === "agent") &&
        typeof participant.id === "string"
          ? nameOf({ type: participant.type, id: participant.id })
          : undefined;
      return ` to ${name ?? (participant?.type === "human" ? "a teammate" : "an agent")}`;
    }
    case "run.woken":
      return typeof payload.integration === "string" && payload.integration
        ? ` (${payload.integration})`
        : "";
    default:
      return "";
  }
}

export function activityTaskId(event: ProjectEvent) {
  const taskId = event.payload.task_id;
  if (typeof taskId === "string") return taskId;
  return event.type.startsWith("task.") ? event.entity_id : null;
}
