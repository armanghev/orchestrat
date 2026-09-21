import { describe, expect, it } from "vitest";
import type { ProjectEvent } from "@orchestrat/protocol";
import { activityTaskId, activityVerb } from "./activity-copy";

describe("activityVerb", () => {
  it("uses readable language for task activity", () => {
    expect(activityVerb("task.comment_created")).toBe("commented on");
    expect(activityVerb("task.dependency_added")).toBe("added a dependency to");
  });

  it("keeps unknown event types readable", () => {
    expect(activityVerb("hook.triggered")).toBe("hook triggered");
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
});
