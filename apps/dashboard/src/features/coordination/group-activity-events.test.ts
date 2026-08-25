import { describe, expect, it } from "vitest";
import type { ProjectEvent } from "@orchestrat/protocol";
import { groupActivityEvents } from "./group-activity-events";

const event = (
  id: number,
  overrides: Partial<ProjectEvent> = {}
): ProjectEvent => ({
  id,
  project_id: "00000000-0000-4000-8000-000000000001",
  type: "document.updated",
  actor_agent_id: null,
  actor_user_id: "00000000-0000-4000-8000-000000000002",
  entity_id: "00000000-0000-4000-8000-000000000003",
  payload: { revision: id, save_kind: "autosave" },
  occurred_at: new Date(id * 1_000).toISOString(),
  ...overrides
});

describe("groupActivityEvents", () => {
  it("groups only consecutive updates for the same document and actor", () => {
    const groups = groupActivityEvents([
      event(4),
      event(3),
      event(2, { actor_user_id: null, type: "task.updated" }),
      event(1)
    ]);

    expect(groups.map((group) => group.events.map(({ id }) => id))).toEqual([
      [4, 3],
      [2],
      [1]
    ]);
  });

  it("keeps explicit document writes separate", () => {
    const groups = groupActivityEvents([
      event(3),
      event(2, { payload: { revision: 2 } }),
      event(1)
    ]);

    expect(groups.map((group) => group.events.map(({ id }) => id))).toEqual([
      [3],
      [2],
      [1]
    ]);
  });
});
