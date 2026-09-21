export function activityVerb(type: string) {
  const verbs: Record<string, string> = {
    "task.created": "created",
    "task.updated": "updated",
    "task.moved": "moved",
    "task.comment_created": "commented on",
    "task.dependency_added": "added a dependency to",
    "task.dependency_removed": "removed a dependency from",
    "task.done": "completed",
    "document.created": "created",
    "document.updated": "updated",
    "agent.created": "connected",
    "agent.revoked": "revoked",
    "claim.created": "claimed",
    "claim.completed": "completed",
    "claim.expired": "expired the claim on",
    "claim.revoked": "released",
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

export function activityTaskId(event: ProjectEvent) {
  const taskId = event.payload.task_id;
  if (typeof taskId === "string") return taskId;
  return event.type.startsWith("task.") ? event.entity_id : null;
}
import type { ProjectEvent } from "@orchestrat/protocol";
