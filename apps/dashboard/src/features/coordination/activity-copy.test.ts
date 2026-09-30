import { describe, expect, it } from "vitest";
import type { ProjectEvent } from "@orchestrat/protocol";
import { activitySuffix, activityTaskId, activityVerb } from "./activity-copy";

describe("activityVerb", () => {
  it("uses readable language for task activity", () => {
    expect(activityVerb("task.comment_created")).toBe("commented on");
    expect(activityVerb("task.dependency_added")).toBe("added a dependency to");
  });

  it("keeps unknown event types readable", () => {
    expect(activityVerb("hook.unknown_event")).toBe("hook unknown event");
    expect(activityVerb("credential.issued")).toBe("issued a credential");
    expect(activityVerb("claim.expired")).toBe("expired the claim on");
  });

  it("uses payload task IDs for claim activity", () => {
    const event = {
      id: 1,
      project_id: "00000000-0000-4000-8000-000000000001",
      type: "claim.completed",
      actor_agent_id: null,
      actor_user_id: null,
      entity_id: "00000000-0000-4000-8000-000000000002",
      payload: { task_id: "00000000-0000-4000-8000-000000000003" },
      occurred_at: "2024-01-01T00:00:00.000Z"
    } satisfies ProjectEvent;

    expect(activityVerb(event.type)).toBe("completed");
    expect(activityTaskId(event)).toBe(event.payload.task_id);
  });

  it("describes agent status changes by their target status", () => {
    const line = (payload: Record<string, unknown>) =>
      `${activityVerb("task.status_changed", payload)} ORC-3${activitySuffix({
        type: "task.status_changed",
        payload
      })}`;
    expect(line({ from_status: "in_progress", to_status: "blocked" })).toBe(
      "is blocked on ORC-3"
    );
    expect(line({ from_status: "in_progress", to_status: "review" })).toBe(
      "submitted ORC-3 for review"
    );
    expect(line({ from_status: "claimed", to_status: "in_progress" })).toBe(
      "started work on ORC-3"
    );
    expect(line({ from_status: "blocked", to_status: "in_progress" })).toBe(
      "resumed work on ORC-3"
    );
    expect(line({ from_status: "blocked", to_status: "ready" })).toBe(
      "moved ORC-3 to ready"
    );
  });

  it("names why a blocker was resolved without claiming a human did it", () => {
    const line = (resolution: string) =>
      `${activityVerb("task.block_resolved")} ORC-3${activitySuffix({
        type: "task.block_resolved",
        payload: { block_id: "b", resolution, to_status: "ready" }
      })}`;
    expect(line("blocking_task_done")).toBe(
      "resolved the blocker on ORC-3 after its blocking task was done"
    );
    expect(line("participant_responded")).toBe(
      "resolved the blocker on ORC-3 by responding"
    );
    expect(line("resolved_by_human")).toBe("resolved the blocker on ORC-3");
  });

  it("describes handoffs and wakes", () => {
    const codex = "00000000-0000-4000-8000-000000000009";
    const handoff = {
      type: "chat.handoff_created",
      payload: {
        message_id: "m",
        handoff_id: "h",
        participant: { type: "agent", id: codex },
        task_id: "00000000-0000-4000-8000-000000000003",
        hop: 0
      }
    };
    expect(activityVerb(handoff.type, handoff.payload)).toBe("handed off");
    expect(
      activitySuffix(handoff, ({ id }) => (id === codex ? "codex" : undefined))
    ).toBe(" to codex");
    expect(activitySuffix(handoff)).toBe(" to an agent");
    expect(activityTaskId({ ...event(handoff), entity_id: null })).toBe(
      handoff.payload.task_id
    );
    expect(
      activityVerb("run.woken", { integration: "codex", handoff_id: "h" })
    ).toBe("was woken for a handoff");
    expect(activityVerb("run.woken", { integration: "codex" })).toBe(
      "was woken by the local waker"
    );
    expect(
      activitySuffix({ type: "run.woken", payload: { integration: "codex" } })
    ).toBe(" (codex)");
  });
});

function event({
  type,
  payload
}: {
  type: string;
  payload: Record<string, unknown>;
}): ProjectEvent {
  return {
    id: 1,
    project_id: "00000000-0000-4000-8000-000000000001",
    type,
    actor_agent_id: null,
    actor_user_id: null,
    entity_id: null,
    payload,
    occurred_at: "2024-01-01T00:00:00.000Z"
  };
}
