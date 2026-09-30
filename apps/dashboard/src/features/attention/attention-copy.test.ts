import { describe, expect, it } from "vitest";
import { DashboardApiError } from "@/lib/api/client";
import { agentAttention, taskBlock } from "@/test/factories";
import {
  agentAttentionLine,
  blockIsGone,
  blockedTaskLine,
  handoffErrorMessage,
  relativeTime,
  resolveBlockErrorMessage
} from "./attention-copy";

const taskRef = {
  id: "00000000-0000-4000-8000-000000000041",
  key: "ORC-4",
  title: "Ship the API"
};
const codex = {
  type: "agent" as const,
  id: "00000000-0000-4000-8000-000000000021",
  name: "codex"
};

describe("blockedTaskLine", () => {
  it("names the blocking task, the participant, or falls back to the reason", () => {
    expect(blockedTaskLine(taskBlock({ blocked_on: codex }))).toBe(
      "Blocked · waiting on codex"
    );
    expect(blockedTaskLine(taskBlock({ blocking_task: taskRef }))).toBe(
      "Blocked by ORC-4"
    );
    expect(
      blockedTaskLine(taskBlock({ blocking_task: taskRef, blocked_on: codex }))
    ).toBe("Blocked by ORC-4 · waiting on codex");
    expect(blockedTaskLine(taskBlock({ reason: "Needs a decision." }))).toBe(
      "Blocked · Needs a decision."
    );
  });
});

describe("relativeTime", () => {
  it("uses compact past-tense units", () => {
    const now = Date.parse("2026-09-28T12:00:00.000Z");
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(relativeTime(ago(20_000), now)).toBe("just now");
    expect(relativeTime(ago(5 * 60_000), now)).toBe("5 min ago");
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe("3 hr ago");
    expect(relativeTime(ago(24 * 3_600_000), now)).toBe("1 day ago");
    expect(relativeTime(ago(72 * 3_600_000), now)).toBe("3 days ago");
    // Clock skew never produces "in the future" copy.
    expect(relativeTime(ago(-60_000), now)).toBe("just now");
  });
});

describe("agentAttentionLine", () => {
  it("matches the spec examples", () => {
    expect(
      agentAttentionLine(
        agentAttention({
          current_task: { ...taskRef, key: "ORC-3", status: "in_progress" }
        })
      )
    ).toEqual({ tone: "working", text: "Working on ORC-3 · in progress" });
    expect(
      agentAttentionLine(
        agentAttention({
          open_block: { task: taskRef, reason: "Waiting on review" },
          current_task: { ...taskRef, status: "blocked" }
        })
      )
    ).toEqual({ tone: "blocked", text: "Blocked on ORC-4" });
    expect(
      agentAttentionLine(
        agentAttention({ waiting_since: "2026-09-28T12:00:00.000Z" })
      )
    ).toEqual({ tone: "waiting", text: "Waiting for updates" });
    expect(
      agentAttentionLine(agentAttention({ pending_directed_count: 2 }))
    ).toEqual({ tone: "idle", text: "2 pending items" });
    expect(agentAttentionLine(agentAttention())).toEqual({
      tone: "idle",
      text: "No pending items"
    });
  });

  it("combines a blocked agent that waits and has pending items", () => {
    expect(
      agentAttentionLine(
        agentAttention({
          open_block: { task: taskRef, reason: "Waiting on codex" },
          waiting_since: "2026-09-28T12:00:00.000Z",
          pending_directed_count: 1
        })
      ).text
    ).toBe("Blocked on ORC-4 · waiting for updates · 1 pending item");
  });
});

describe("error copy", () => {
  const error = (kind: ConstructorParameters<typeof DashboardApiError>[1]) =>
    new DashboardApiError("failed", kind, 429, "request");

  it("explains handoff limits and keeps unknown failures generic", () => {
    expect(handoffErrorMessage(error("HANDOFF_RATE_LIMITED"))).toMatch(
      /Too many pings/
    );
    expect(handoffErrorMessage(error("HANDOFF_CHAIN_LIMIT"))).toMatch(
      /Too many pings/
    );
    expect(handoffErrorMessage(error("NETWORK_ERROR"))).toMatch(
      /couldn’t reach/
    );
    expect(handoffErrorMessage(new Error("boom"))).toBe(
      "Something went wrong. Try again."
    );
  });

  it("treats a missing blocker as already resolved", () => {
    expect(resolveBlockErrorMessage(error("NOT_FOUND"))).toBe(
      "This blocker was already resolved. Close this to see the latest task."
    );
    expect(blockIsGone(error("INVALID_STATUS_TRANSITION"))).toBe(true);
    expect(blockIsGone(error("NETWORK_ERROR"))).toBe(false);
    expect(resolveBlockErrorMessage(error("INTERNAL_ERROR"))).toBe(
      "The blocker wasn’t resolved. Try again."
    );
  });
});
