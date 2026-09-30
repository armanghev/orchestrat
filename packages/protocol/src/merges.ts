import { z } from "zod";

// Import, merge and decision contracts (docs/project-branches.md §9). Imports
// only zod; see branches.ts for why.
const idSchema = z.string().uuid();
const dateSchema = z.string().datetime();
const cursorSchema = z.string().trim().min(1).max(2048);

export const mergeKindSchema = z.enum(["import", "merge"]);
export type MergeKind = z.infer<typeof mergeKindSchema>;
export const mergeTriggerSchema = z.enum(["dashboard", "provider_merge"]);
export type MergeTrigger = z.infer<typeof mergeTriggerSchema>;
export const mergeRunStatusSchema = z.enum([
  "applied",
  "applied_with_decisions",
  "skipped",
  "failed"
]);
export type MergeRunStatus = z.infer<typeof mergeRunStatusSchema>;
export const mergeSkipReasonSchema = z.enum([
  "no_source_branch",
  "fork",
  "same_branch",
  "source_empty"
]);
export type MergeSkipReason = z.infer<typeof mergeSkipReasonSchema>;

/** Top-level selectable items. Children (comments, revisions, attachments,
 * folders, messages) travel with their parent. */
export const mergeItemTypeSchema = z.enum(["task", "document", "chat"]);
export type MergeItemType = z.infer<typeof mergeItemTypeSchema>;

export const mergeOutcomeSchema = z.enum([
  "copy",
  "apply",
  "unchanged",
  "keep_target",
  "conflict",
  "skipped"
]);
export type MergeOutcome = z.infer<typeof mergeOutcomeSchema>;

export const mergeItemReasonSchema = z.enum([
  "changed_on_both",
  "added_on_both",
  "path_collision",
  "target_claimed",
  "audience_would_widen",
  "dependency_cycle",
  "too_large"
]);
export type MergeItemReason = z.infer<typeof mergeItemReasonSchema>;

export const mergeChoiceSchema = z.enum(["use_source", "use_target"]);
export type MergeChoice = z.infer<typeof mergeChoiceSchema>;

const selectionListSchema = z.union([
  z.literal("all"),
  z.array(idSchema).max(2000)
]);
/** Lineage keys to import, per item type (spec §9.5). */
export const mergeSelectionSchema = z.object({
  tasks: selectionListSchema.default([]),
  documents: selectionListSchema.default([]),
  chats: selectionListSchema.default([])
});
export type MergeSelection = z.infer<typeof mergeSelectionSchema>;

export const mergePreviewItemSchema = z.object({
  item_type: mergeItemTypeSchema,
  lineage_key: idSchema,
  source_id: idSchema,
  target_id: idSchema.nullable(),
  outcome: mergeOutcomeSchema,
  reason: mergeItemReasonSchema.nullable(),
  fields: z.array(z.string()),
  required_by: z.array(idSchema),
  label: z.string(),
  task_key: z.string().nullable(),
  audience: z
    .array(
      z.object({
        type: z.enum(["human", "agent"]),
        id: idSchema,
        name: z.string()
      })
    )
    .nullable(),
  source_values: z.record(z.string(), z.unknown()).nullable(),
  target_values: z.record(z.string(), z.unknown()).nullable()
});
export type MergePreviewItem = z.infer<typeof mergePreviewItemSchema>;

export const mergeCountsSchema = z.record(
  z.string(),
  z.number().int().nonnegative()
);
export type MergeCounts = z.infer<typeof mergeCountsSchema>;

export const mergePreviewSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  kind: mergeKindSchema,
  source_branch_id: idSchema,
  target_branch_id: idSchema,
  items: z.array(mergePreviewItemSchema),
  counts: mergeCountsSchema
});
export type MergePreview = z.infer<typeof mergePreviewSchema>;

export const mergePreviewRequestSchema = z.object({
  source_branch_id: idSchema,
  target_branch_id: idSchema,
  kind: mergeKindSchema,
  selection: mergeSelectionSchema.optional()
});
export type MergePreviewRequest = z.infer<typeof mergePreviewRequestSchema>;
export const mergePreviewResponseSchema = z.object({
  preview: mergePreviewSchema
});
export type MergePreviewResponse = z.infer<typeof mergePreviewResponseSchema>;

export const mergeApplyRequestSchema = z.object({
  source_branch_id: idSchema,
  target_branch_id: idSchema,
  kind: mergeKindSchema,
  selection: mergeSelectionSchema.optional(),
  choices: z.record(idSchema, mergeChoiceSchema).default({}),
  preview_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  archive_source: z.boolean().default(false),
  complete_onboarding: z.boolean().default(false)
});
export type MergeApplyRequest = z.infer<typeof mergeApplyRequestSchema>;

export const mergeSkippedItemSchema = z.object({
  item_type: z.string(),
  lineage_key: idSchema,
  label: z.string(),
  reason: mergeItemReasonSchema
});
export type MergeSkippedItem = z.infer<typeof mergeSkippedItemSchema>;

export const mergeRunSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  source_branch_id: idSchema,
  target_branch_id: idSchema,
  kind: mergeKindSchema,
  trigger: mergeTriggerSchema,
  status: mergeRunStatusSchema,
  skip_reason: mergeSkipReasonSchema.nullable(),
  provider: z
    .object({
      provider: z.enum(["github", "gitlab", "origin"]),
      change_number: z.string().nullable(),
      change_url: z.string().nullable(),
      head_sha: z.string().nullable(),
      merge_sha: z.string().nullable()
    })
    .nullable(),
  counts: mergeCountsSchema,
  skipped: z.array(mergeSkippedItemSchema),
  decision_count: z.number().int().nonnegative(),
  created_by: z
    .object({ type: z.enum(["human", "agent"]), id: idSchema })
    .nullable(),
  created_at: dateSchema,
  applied_at: dateSchema.nullable()
});
export type MergeRun = z.infer<typeof mergeRunSchema>;
export const mergeRunResponseSchema = z.object({ run: mergeRunSchema });
export type MergeRunResponse = z.infer<typeof mergeRunResponseSchema>;
export const mergeRunsQuerySchema = z.object({
  branch_id: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: cursorSchema.optional()
});
export type MergeRunsQuery = z.infer<typeof mergeRunsQuerySchema>;
export const mergeRunsResponseSchema = z.object({
  runs: z.array(mergeRunSchema),
  next_cursor: cursorSchema.nullable()
});
export type MergeRunsResponse = z.infer<typeof mergeRunsResponseSchema>;

/** Stale preview (409 BRANCH_PREVIEW_STALE) carries the fresh preview. */
export const mergePreviewStaleDetailsSchema = z.object({
  preview: mergePreviewSchema
});

export const decisionReasonSchema = z.enum([
  "changed_on_both",
  "added_on_both",
  "path_collision",
  "target_claimed"
]);
export type DecisionReason = z.infer<typeof decisionReasonSchema>;
export const decisionStatusSchema = z.enum([
  "open",
  "resolved_source",
  "resolved_target",
  "superseded"
]);
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;

export const decisionSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  run_id: idSchema,
  source_branch_id: idSchema,
  target_branch_id: idSchema,
  item_type: mergeItemTypeSchema,
  lineage_key: idSchema,
  source_item_id: idSchema,
  target_item_id: idSchema,
  label: z.string(),
  reason: decisionReasonSchema,
  fields: z.array(z.string()),
  source_values: z.record(z.string(), z.unknown()),
  target_values: z.record(z.string(), z.unknown()),
  status: decisionStatusSchema,
  resolved_by_user_id: idSchema.nullable(),
  resolved_at: dateSchema.nullable(),
  created_at: dateSchema
});
export type Decision = z.infer<typeof decisionSchema>;
export const decisionsQuerySchema = z.object({
  branch_id: idSchema.optional(),
  status: decisionStatusSchema.optional()
});
export type DecisionsQuery = z.infer<typeof decisionsQuerySchema>;
export const decisionsResponseSchema = z.object({
  decisions: z.array(decisionSchema)
});
export type DecisionsResponse = z.infer<typeof decisionsResponseSchema>;
export const decisionResponseSchema = z.object({ decision: decisionSchema });
export type DecisionResponse = z.infer<typeof decisionResponseSchema>;
export const resolveDecisionRequestSchema = z.object({
  choice: mergeChoiceSchema
});
export type ResolveDecisionRequest = z.infer<
  typeof resolveDecisionRequestSchema
>;
export const decisionParamsSchema = z.object({
  projectId: idSchema,
  decisionId: idSchema
});
