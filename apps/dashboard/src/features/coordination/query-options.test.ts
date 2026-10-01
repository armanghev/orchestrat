import { describe, expect, it, vi } from "vitest";
import type { RealtimeEventEnvelope } from "@orchestrat/protocol";
import {
  ALL_BRANCHES,
  coordinationKeys,
  invalidateRealtimeEvent
} from "./query-options";
import { messagingKeys } from "@/features/messaging/query-options";
import { branchKeys } from "@/features/branches/query-options";

describe("coordination query keys", () => {
  it("keeps infinite activity pages separate from the normal event list", () => {
    expect(coordinationKeys.eventsInfinite("project-1")).not.toEqual(
      coordinationKeys.events("project-1")
    );
    expect(coordinationKeys.eventsInfinite("project-1")).toEqual([
      "coordination",
      "events",
      "project-1",
      "infinite"
    ]);
  });

  it("puts the branch last so the project key matches every branch", () => {
    expect(coordinationKeys.tasks("project-1", "branch-1")).toEqual([
      ...coordinationKeys.tasks("project-1"),
      "branch-1"
    ]);
    expect(messagingKeys.chats("project-1", "branch-1")).toEqual([
      ...messagingKeys.chats("project-1"),
      "branch-1"
    ]);
  });
});

describe("branch-aware realtime invalidation", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const branchId = "22222222-2222-4222-8222-222222222222";
  const entityId = "33333333-3333-4333-8333-333333333333";
  const invalidated = async (event: Partial<RealtimeEventEnvelope>) => {
    const invalidateQueries = vi.fn<
      (options: { queryKey: unknown[] }) => Promise<void>
    >(async () => undefined);
    await invalidateRealtimeEvent(
      {
        invalidateQueries,
        removeQueries: vi.fn(),
        setQueriesData: vi.fn()
      } as never,
      projectId,
      {
        project_id: projectId,
        sequence: 1,
        entity_id: entityId,
        ...event
      } as RealtimeEventEnvelope
    );
    return invalidateQueries.mock.calls.map(([options]) => options.queryKey);
  };

  it("refreshes only the event's branch, plus the all-branches views", async () => {
    const keys = await invalidated({
      branch_id: branchId,
      event_type: "task.updated",
      entity_type: "task"
    });
    expect(keys).toEqual(
      expect.arrayContaining([
        coordinationKeys.tasks(projectId, branchId),
        coordinationKeys.events(projectId, branchId),
        coordinationKeys.events(projectId, ALL_BRANCHES)
      ])
    );
    expect(keys).not.toContainEqual(coordinationKeys.tasks(projectId));
    expect(keys).not.toContainEqual(coordinationKeys.events(projectId));
  });

  it("refreshes every branch for project-wide and older envelopes", async () => {
    for (const branch_id of [null, undefined])
      expect(
        await invalidated({
          branch_id,
          event_type: "task.updated",
          entity_type: "task"
        })
      ).toEqual(
        expect.arrayContaining([
          coordinationKeys.tasks(projectId),
          coordinationKeys.events(projectId)
        ])
      );
  });

  it("scopes chat events to the chat's branch", async () => {
    const keys = await invalidated({
      branch_id: branchId,
      event_type: "chat.message_created",
      entity_type: "chat"
    });
    expect(keys).toEqual(
      expect.arrayContaining([
        messagingKeys.chats(projectId, branchId),
        messagingKeys.inbox(projectId, branchId),
        messagingKeys.inboxAllBranches(projectId),
        messagingKeys.messages(entityId)
      ])
    );
    expect(keys).not.toContainEqual(messagingKeys.chats(projectId));
  });

  it("refetches the branch list on branch and repository events", async () => {
    for (const event_type of [
      "branch.created",
      "branch.archived",
      "branch.default_changed"
    ])
      expect(
        await invalidated({
          branch_id: null,
          event_type,
          entity_type: "branch"
        })
      ).toContainEqual(branchKeys.project(projectId));
    expect(
      await invalidated({
        branch_id: null,
        event_type: "repository.connected",
        entity_type: "repository"
      })
    ).toContainEqual(branchKeys.project(projectId));
  });

  it("refreshes the whole target branch after a merge or a decision", async () => {
    for (const [event_type, entity_type] of [
      ["merge.merge_applied", "merge"],
      ["merge.import_applied", "merge"],
      ["decision.resolved", "decision"]
    ] as const) {
      const keys = await invalidated({
        branch_id: branchId,
        event_type,
        entity_type
      });
      expect(keys).toEqual(
        expect.arrayContaining([
          branchKeys.project(projectId),
          coordinationKeys.tasks(projectId, branchId),
          coordinationKeys.documents(projectId, branchId),
          messagingKeys.chats(projectId, branchId),
          coordinationKeys.events(projectId, branchId),
          ["coordination", "task"],
          ["coordination", "document"]
        ])
      );
      expect(keys).not.toContainEqual(coordinationKeys.tasks(projectId));
    }
  });
});
