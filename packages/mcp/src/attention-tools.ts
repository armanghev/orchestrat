import type { McpServer } from "@modelcontextprotocol/server";
import type { AgentApiClient } from "@orchestrat/sdk";
import {
  acknowledgeAttentionRequestSchema,
  taskWatchRequestSchema,
  type AttentionSummary
} from "@orchestrat/protocol";
import { z } from "zod";
import type { ClaimTokenStore } from "./index.js";
import { registerHandoffTool } from "./handoff-tool.js";
import { registerStatusTool } from "./status-tool.js";
import { registerWaitTool } from "./wait-tool.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

// The slice of McpBridge the attention tools need, built by
// McpBridge.attentionHost(). `call` wraps an operation exactly like the
// bridge's own tools: success/error mapping plus the unread notices.
export type AttentionToolHost = {
  server: McpServer;
  call<T>(
    operation: () => Promise<T>,
    options?: { notifyInbox?: boolean }
  ): Promise<ToolResult>;
  client(): Pick<AgentApiClient, "attention">;
  requireSession(): string;
  claims: ClaimTokenStore;
  integration: string;
  waitBudgetSeconds?: number;
};

const NOTICE_LIMIT = 5;

// Compact per-call notice. Returns undefined when nothing needs the agent's
// attention so quiet calls stay one content block long.
export function attentionNotice(summary: AttentionSummary) {
  const { tasks, handoffs, blockers_resolved } = summary;
  if (!tasks.length && !handoffs.length && !blockers_resolved.length)
    return undefined;
  return {
    notice: {
      type: "attention" as const,
      tasks: tasks.slice(0, NOTICE_LIMIT).map((task) => ({
        task_id: task.task_id,
        key: task.key,
        unread_comments: task.unread_count,
        mentions: task.mention_count,
        claimed_by_you: task.claimed_by_you,
        latest_sequence: task.latest_sequence
      })),
      handoffs: handoffs.slice(0, NOTICE_LIMIT).map((handoff) => ({
        handoff_id: handoff.handoff_id,
        from: { type: handoff.from.type, name: handoff.from.name },
        task_key: handoff.task?.key ?? null
      })),
      blockers_resolved: blockers_resolved
        .slice(0, NOTICE_LIMIT)
        .map((blocker) => ({
          block_id: blocker.block_id,
          task_key: blocker.task.key,
          resolution: blocker.resolution
        })),
      hint: "Read with get_attention; acknowledge with acknowledge_attention.",
      branch_id: summary.branch_id
    }
  };
}

export function registerAttentionTools(host: AttentionToolHost) {
  host.server.registerTool(
    "get_attention",
    {
      description:
        "Read what needs this agent's attention: unread task comments (with excerpts and mentions), pending handoffs, resolved blockers and unread chats. Acknowledge items with acknowledge_attention after reading them.",
      inputSchema: {}
    },
    // The full summary already carries unread chats, so skip the notice.
    async () =>
      host.call(() => host.client().attention.summary(), {
        notifyInbox: false
      })
  );
  host.server.registerTool(
    "acknowledge_attention",
    {
      description:
        "Mark attention items handled after reading them: task comments through a sequence, a handoff, or a resolved blocker. Chat messages use acknowledge_messages instead.",
      inputSchema: { items: acknowledgeAttentionRequestSchema.shape.items }
    },
    async (input) =>
      host.call(() =>
        host
          .client()
          .attention.acknowledge(acknowledgeAttentionRequestSchema.parse(input))
      )
  );
  host.server.registerTool(
    "watch_task",
    {
      description:
        "Watch a task to get its new comments in attention, or pass watching:false to mute it. Mentions of this agent still surface while muted.",
      inputSchema: {
        task_id: z.string().uuid(),
        ...taskWatchRequestSchema.shape
      }
    },
    async ({ task_id, watching }) =>
      host.call(() => host.client().attention.watch(task_id, watching))
  );
  registerWaitTool(host);
  registerStatusTool(host);
  registerHandoffTool(host);
}
