import type { AgentAttention, TaskBlock } from "@orchestrat/protocol";
import { DashboardApiError } from "@/lib/api/client";

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Board and list line for a blocked task (spec §14). */
export function blockedTaskLine(
  block: Pick<TaskBlock, "blocking_task" | "blocked_on" | "reason">
) {
  const parts = [
    block.blocking_task ? `Blocked by ${block.blocking_task.key}` : "Blocked",
    ...(block.blocked_on ? [`waiting on ${block.blocked_on.name}`] : [])
  ];
  if (!block.blocking_task && !block.blocked_on) parts.push(block.reason);
  return parts.join(" · ");
}

/** Compact past tense for metadata lines: "just now", "5 min ago". */
export function relativeTime(value: string, now: number) {
  const seconds = Math.max(0, Math.round((now - Date.parse(value)) / 1000));
  if (!Number.isFinite(seconds) || seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${plural(Math.floor(hours / 24), "day")} ago`;
}

export type AgentAttentionTone = "blocked" | "working" | "waiting" | "idle";

/**
 * One status line per agent on the Agents page, e.g. "Working on ORC-3 · in
 * progress", "Blocked on ORC-4 · waiting for updates", "2 pending items".
 */
export function agentAttentionLine(item: AgentAttention): {
  tone: AgentAttentionTone;
  text: string;
} {
  const parts: string[] = [];
  let tone: AgentAttentionTone = "idle";
  if (item.open_block) {
    parts.push(`blocked on ${item.open_block.task.key}`);
    tone = "blocked";
  } else if (item.current_task) {
    parts.push(
      `working on ${item.current_task.key} · ${item.current_task.status.replaceAll("_", " ")}`
    );
    tone = "working";
  }
  if (item.waiting_since) {
    parts.push("waiting for updates");
    if (tone === "idle") tone = "waiting";
  }
  if (item.pending_directed_count > 0)
    parts.push(plural(item.pending_directed_count, "pending item"));
  const text = parts.join(" · ") || "no pending items";
  return { tone, text: text.charAt(0).toUpperCase() + text.slice(1) };
}

/** Plain-language failures for the Ping dialog; the draft is always kept. */
export function handoffErrorMessage(error: unknown) {
  if (!(error instanceof DashboardApiError))
    return "Something went wrong. Try again.";
  switch (error.kind) {
    case "NETWORK_ERROR":
      return "We couldn’t reach Orchestrat. Check your connection and try again.";
    case "HANDOFF_CHAIN_LIMIT":
    case "HANDOFF_RATE_LIMITED":
    case "RATE_LIMITED":
      return "Too many pings were sent recently. Wait a few minutes and try again.";
    case "PERMISSION_DENIED":
      return "You don’t have permission to ping in this project.";
    case "PROJECT_ARCHIVED":
      return "This project is archived and read-only.";
    case "VALIDATION_ERROR":
    case "NOT_FOUND":
      return "That recipient or task is no longer available. Choose another and try again.";
    default:
      return "The ping wasn’t sent. Try again.";
  }
}

/** The block closed before this resolve arrived (another person or agent). */
export function blockIsGone(error: unknown) {
  return (
    error instanceof DashboardApiError &&
    (error.kind === "NOT_FOUND" ||
      error.kind === "CONFLICT" ||
      error.kind === "INVALID_STATUS_TRANSITION")
  );
}

/** Failures for Resolve blocker. */
export function resolveBlockErrorMessage(error: unknown) {
  if (!(error instanceof DashboardApiError))
    return "Something went wrong. Try again.";
  if (blockIsGone(error))
    return "This blocker was already resolved. Close this to see the latest task.";
  switch (error.kind) {
    case "NETWORK_ERROR":
      return "We couldn’t reach Orchestrat. Check your connection and try again.";
    case "PERMISSION_DENIED":
      return "You don’t have permission to change this task.";
    case "PROJECT_ARCHIVED":
      return "This project is archived and read-only.";
    default:
      return "The blocker wasn’t resolved. Try again.";
  }
}
