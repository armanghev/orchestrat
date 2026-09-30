import { z } from "zod";

// Agent attention contracts (spec §6). This module imports only zod and never
// imports index.ts: `export *` from index.ts evaluates this file first, so any
// back-reference to index.ts primitives would hit a TDZ error. The primitives
// below mirror index.ts deliberately.
const idSchema = z.string().uuid();
const dateSchema = z.string().datetime();
const excerptSchema = z.string().max(280);
const countSchema = z.number().int().nonnegative();
const sequenceSchema = z.number().int().nonnegative();
const taskStatusSchema = z.enum([
  "backlog",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "review",
  "done",
  "cancelled"
]);
const claimStatusSchema = z.enum([
  "active",
  "released",
  "completed",
  "expired",
  "revoked"
]);

export const attentionErrorCodeSchema = z.enum([
  "TASK_COMMENTS_UNREAD",
  "WATCH_LIMIT",
  "INVALID_STATUS_TRANSITION",
  "BLOCKER_CYCLE",
  "WAIT_LIMIT",
  "HANDOFF_CHAIN_LIMIT",
  "HANDOFF_RATE_LIMITED",
  "WAKE_LIMIT"
]);
export type AttentionErrorCode = z.infer<typeof attentionErrorCodeSchema>;

// Shared shapes.
export const attentionParticipantRefSchema = z.object({
  type: z.enum(["human", "agent"]),
  id: idSchema
});
export type AttentionParticipantRef = z.infer<
  typeof attentionParticipantRefSchema
>;
export const attentionActorSchema = attentionParticipantRefSchema.extend({
  name: z.string()
});
export type AttentionActor = z.infer<typeof attentionActorSchema>;
export const attentionTaskRefSchema = z.object({
  id: idSchema,
  key: z.string(),
  title: z.string()
});
export type AttentionTaskRef = z.infer<typeof attentionTaskRefSchema>;

export const taskBlockResolutionSchema = z.enum([
  "blocking_task_done",
  "blocking_task_cancelled",
  "participant_responded",
  "status_changed",
  "moved_by_human",
  "resolved_by_human",
  "released"
]);
export type TaskBlockResolution = z.infer<typeof taskBlockResolutionSchema>;

// Summary.
export const attentionTaskItemSchema = z.object({
  task_id: idSchema,
  key: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  watching: z.boolean(),
  claimed_by_you: z.boolean(),
  unread_count: countSchema,
  mention_count: countSchema,
  blocking_unread_count: countSchema,
  last_read_sequence: sequenceSchema,
  latest_sequence: sequenceSchema,
  unread: z
    .array(
      z.object({
        sequence: z.number().int().positive(),
        author: attentionActorSchema,
        excerpt: excerptSchema,
        created_at: dateSchema,
        mentions_you: z.boolean()
      })
    )
    .max(5)
});
export type AttentionTaskItem = z.infer<typeof attentionTaskItemSchema>;
export const attentionHandoffItemSchema = z.object({
  handoff_id: idSchema,
  from: attentionActorSchema,
  chat_id: idSchema,
  message_id: idSchema,
  sequence: z.number().int().positive(),
  task: attentionTaskRefSchema.nullable(),
  excerpt: excerptSchema,
  created_at: dateSchema,
  hop: countSchema
});
export type AttentionHandoffItem = z.infer<typeof attentionHandoffItemSchema>;
export const attentionBlockerItemSchema = z.object({
  block_id: idSchema,
  task: attentionTaskRefSchema,
  resolution: taskBlockResolutionSchema,
  resolved_at: dateSchema
});
export type AttentionBlockerItem = z.infer<typeof attentionBlockerItemSchema>;
export const attentionSummarySchema = z.object({
  cursor: z.string(),
  branch_id: z.string().nullable(),
  unread_chats: z.array(
    z.object({
      chat_id: idSchema,
      unread_count: countSchema,
      mention_count: countSchema
    })
  ),
  tasks: z.array(attentionTaskItemSchema),
  handoffs: z.array(attentionHandoffItemSchema),
  blockers_resolved: z.array(attentionBlockerItemSchema),
  truncated: z.boolean()
});
export type AttentionSummary = z.infer<typeof attentionSummarySchema>;

// Acknowledge, watch, read.
export const acknowledgeAttentionItemSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task_comments"),
    task_id: idSchema,
    through_sequence: sequenceSchema
  }),
  z.object({ type: z.literal("handoff"), handoff_id: idSchema }),
  z.object({ type: z.literal("blocker"), block_id: idSchema })
]);
export type AcknowledgeAttentionItem = z.infer<
  typeof acknowledgeAttentionItemSchema
>;
export const acknowledgeAttentionRequestSchema = z.object({
  items: z.array(acknowledgeAttentionItemSchema).min(1).max(50)
});
export type AcknowledgeAttentionRequest = z.infer<
  typeof acknowledgeAttentionRequestSchema
>;
export const acknowledgeAttentionResponseSchema = z.object({
  acknowledged: countSchema
});
export type AcknowledgeAttentionResponse = z.infer<
  typeof acknowledgeAttentionResponseSchema
>;
export const taskWatchRequestSchema = z.object({ watching: z.boolean() });
export type TaskWatchRequest = z.infer<typeof taskWatchRequestSchema>;
export const taskWatchReasonSchema = z.enum([
  "created",
  "claimed",
  "commented",
  "mentioned",
  "handoff",
  "explicit"
]);
export type TaskWatchReason = z.infer<typeof taskWatchReasonSchema>;
export const taskWatchSchema = z.object({
  task_id: idSchema,
  state: z.enum(["watching", "muted"]),
  reason: taskWatchReasonSchema,
  last_read_sequence: sequenceSchema
});
export type TaskWatch = z.infer<typeof taskWatchSchema>;
export const markCommentsReadRequestSchema = z.object({
  through_sequence: sequenceSchema
});
export type MarkCommentsReadRequest = z.infer<
  typeof markCommentsReadRequestSchema
>;

// Status and blocks.
export const taskBlockSchema = z.object({
  id: idSchema,
  task_id: idSchema,
  reason: z.string(),
  blocking_task: attentionTaskRefSchema.nullable(),
  blocked_on: attentionActorSchema.nullable(),
  created_by: attentionActorSchema,
  created_at: dateSchema,
  resolved_at: dateSchema.nullable(),
  resolution: taskBlockResolutionSchema.nullable()
});
export type TaskBlock = z.infer<typeof taskBlockSchema>;
export const agentTaskStatusSchema = z.enum([
  "in_progress",
  "blocked",
  "review"
]);
export type AgentTaskStatus = z.infer<typeof agentTaskStatusSchema>;
export const setTaskStatusRequestSchema = z
  .object({
    claim_token: z.string().trim().min(32).max(512),
    status: agentTaskStatusSchema,
    reason: z.string().trim().min(1).max(500).optional(),
    blocked_on: attentionParticipantRefSchema.optional(),
    blocking_task_id: idSchema.optional(),
    acknowledged_through: sequenceSchema.optional()
  })
  .refine((value) => value.status !== "blocked" || Boolean(value.reason), {
    message: "Blocked needs a reason.",
    path: ["reason"]
  })
  .refine(
    (value) =>
      value.status === "blocked" ||
      (value.blocked_on === undefined && value.blocking_task_id === undefined),
    {
      message: "blocked_on and blocking_task_id need status blocked.",
      path: ["status"]
    }
  );
export type SetTaskStatusRequest = z.infer<typeof setTaskStatusRequestSchema>;
export const setTaskStatusResponseSchema = z.object({
  task: z.object({
    id: idSchema,
    key: z.string(),
    status: taskStatusSchema,
    version: z.number().int().positive()
  }),
  claim: z
    .object({
      id: idSchema,
      status: claimStatusSchema,
      lease_expires_at: dateSchema
    })
    .nullable(),
  block: taskBlockSchema.nullable()
});
export type SetTaskStatusResponse = z.infer<typeof setTaskStatusResponseSchema>;

// Wait.
export const waitEventKindSchema = z.enum([
  "direct_message",
  "mention",
  "task_comment",
  "claim_released",
  "status_changed",
  "blocker_resolved",
  "handoff"
]);
export type WaitEventKind = z.infer<typeof waitEventKindSchema>;
export const waitQuerySchema = z.object({
  after: z
    .string()
    .regex(/^[0-9]{1,19}$/)
    .optional(),
  timeout_ms: z.coerce.number().int().min(0).max(25_000).default(25_000),
  directed_only: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) => value === true || value === "true")
    .default(false),
  // Query strings carry kinds as "mention,handoff"; arrays pass through so
  // parsed values can be re-validated.
  kinds: z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (Array.isArray(value) ? value : value.split(","))
        .map((kind) => kind.trim())
        .filter(Boolean)
    )
    .pipe(z.array(waitEventKindSchema).min(1))
    .optional(),
  branch_id: idSchema.optional()
});
export type WaitQuery = z.infer<typeof waitQuerySchema>;
export type WaitQueryInput = z.input<typeof waitQuerySchema>;
export const waitEventSchema = z.object({
  kind: waitEventKindSchema,
  event_id: z.number().int().positive(),
  occurred_at: dateSchema,
  actor: attentionActorSchema.nullable(),
  task: attentionTaskRefSchema.nullable(),
  chat_id: idSchema.optional(),
  message_id: idSchema.optional(),
  comment_sequence: z.number().int().positive().optional(),
  handoff_id: idSchema.optional(),
  from_status: taskStatusSchema.optional(),
  to_status: taskStatusSchema.optional(),
  excerpt: excerptSchema.optional(),
  branch_id: z.string().nullable()
});
export type WaitEvent = z.infer<typeof waitEventSchema>;
export const waitResponseSchema = z.object({
  status: z.enum(["pending", "updates", "timeout"]),
  events: z.array(waitEventSchema).max(50),
  cursor: z.string(),
  attention: attentionSummarySchema
});
export type WaitResponse = z.infer<typeof waitResponseSchema>;

// Handoffs and wakes.
export const createHandoffRequestSchema = z.object({
  to: attentionParticipantRefSchema,
  body_markdown: z.string().trim().min(1).max(4000),
  task_id: idSchema.optional()
});
export type CreateHandoffRequest = z.infer<typeof createHandoffRequestSchema>;
export const handoffSchema = z.object({
  id: idSchema,
  chat_id: idSchema,
  message_id: idSchema,
  message_sequence: z.number().int().positive(),
  from: attentionActorSchema,
  to: attentionActorSchema,
  task: attentionTaskRefSchema.nullable(),
  chain_id: idSchema,
  hop: countSchema,
  created_at: dateSchema
});
export type Handoff = z.infer<typeof handoffSchema>;
export const createHandoffResponseSchema = z.object({ handoff: handoffSchema });
export type CreateHandoffResponse = z.infer<typeof createHandoffResponseSchema>;
export const recordWakeRequestSchema = z.object({
  integration: z.string().trim().min(1).max(64),
  handoff_id: idSchema.nullable()
});
export type RecordWakeRequest = z.infer<typeof recordWakeRequestSchema>;
export const recordWakeResponseSchema = z.object({
  wake_event_id: z.number().int().positive()
});
export type RecordWakeResponse = z.infer<typeof recordWakeResponseSchema>;

// Error details and dashboard overlays.
export const unreadCommentsErrorDetailsSchema = z.object({
  task_id: idSchema,
  latest_sequence: sequenceSchema,
  total_unread: countSchema,
  unread: z
    .array(
      z.object({
        sequence: z.number().int().positive(),
        author: attentionActorSchema,
        excerpt: excerptSchema,
        created_at: dateSchema
      })
    )
    .max(10)
});
export type UnreadCommentsErrorDetails = z.infer<
  typeof unreadCommentsErrorDetailsSchema
>;
export const taskAttentionOverlaySchema = z.object({
  task_id: idSchema,
  watching: z.boolean(),
  unread_count: countSchema,
  mention_count: countSchema,
  claim: z
    .object({
      agent_id: idSchema,
      agent_name: z.string(),
      status: claimStatusSchema,
      lease_expires_at: dateSchema
    })
    .nullable(),
  block: taskBlockSchema.nullable()
});
export type TaskAttentionOverlay = z.infer<typeof taskAttentionOverlaySchema>;
export const taskAttentionOverlaysResponseSchema = z.object({
  tasks: z.array(taskAttentionOverlaySchema)
});
export type TaskAttentionOverlaysResponse = z.infer<
  typeof taskAttentionOverlaysResponseSchema
>;
export const agentAttentionSchema = z.object({
  agent_id: idSchema,
  waiting_since: dateSchema.nullable(),
  pending_directed_count: countSchema,
  open_block: z
    .object({ task: attentionTaskRefSchema, reason: z.string() })
    .nullable(),
  current_task: z
    .object({
      id: idSchema,
      key: z.string(),
      title: z.string(),
      status: taskStatusSchema
    })
    .nullable()
});
export type AgentAttention = z.infer<typeof agentAttentionSchema>;
export const agentAttentionResponseSchema = z.object({
  agents: z.array(agentAttentionSchema)
});
export type AgentAttentionResponse = z.infer<
  typeof agentAttentionResponseSchema
>;
