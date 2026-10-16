import { randomUUID } from "node:crypto";
import {
  agents,
  apiIdempotencyKeys,
  branchMergeDecisions,
  branchMergeRuns,
  chats as chatTable,
  documentAttachmentUploads,
  documentAttachments,
  users,
  type Database
} from "@orchestrat/db";
import type {
  MergeChoice,
  MergePreview,
  MergePreviewItem,
  MergeRun,
  MergeSelection
} from "@orchestrat/protocol";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { insertProjectEvent } from "../agent-service.js";
import { ApiError } from "../api-error.js";
import { DEFAULT_ATTACHMENT_QUOTA_BYTES } from "../../storage-config.js";
import {
  assertBranchWritable,
  findProjectBranch,
  type BranchRow
} from "../branch-context.js";
import type { BranchService } from "../branch-service.js";
import {
  inheritBaselines,
  loadBaselines,
  upsertBaseline,
  type Executor,
  type MergeItemType
} from "./baselines.js";
import {
  audience,
  chatValues,
  insertChatCopy,
  insertMessages,
  loadChatSide,
  planChats,
  type ChatPlanItem,
  type ChatRow,
  type ChatSide
} from "./chat-items.js";
import {
  allocate,
  applyDocumentValues,
  documentValues,
  insertAttachments,
  insertDocumentCopy,
  insertFolders,
  loadDocumentSide,
  planDocuments,
  planFolders,
  type AttachmentCopy,
  type DocumentPlanItem,
  type DocumentRow,
  type DocumentSide
} from "./document-items.js";
import { digest, fingerprintOf, type Fingerprint } from "./fingerprint.js";
import {
  activelyClaimedTaskIds,
  applyTaskValues,
  columnEnds,
  copyComments,
  insertEdge,
  insertTaskCopy,
  lineageOf,
  loadTaskSide,
  planTasks,
  taskValues,
  type EdgePlan,
  type TaskPlanItem,
  type TaskRow,
  type TaskSide
} from "./task-items.js";

// One engine for imports, manual merges and provider merges. plan() reads
// without locks; apply() re-plans under the project lock and writes everything
// in one transaction.

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type RunRow = typeof branchMergeRuns.$inferSelect;
type Counts = Record<string, number>;
type Skipped = MergeRun["skipped"];

export type MergeRequest = {
  sourceBranchId: string;
  targetBranchId: string;
  kind: "import" | "merge";
  selection?: Partial<MergeSelection>;
};

export type ApplyRequest = MergeRequest & {
  trigger: "dashboard" | "provider_merge";
  /** The human applying it; null for provider automation. */
  userId: string | null;
  choices?: Record<string, MergeChoice>;
  /** Dashboard applies confirm the preview they showed. */
  previewFingerprint?: string;
  archiveSource?: boolean;
  completeOnboarding?: boolean;
  idempotencyKey?: string;
  /** Provider runs are deduplicated per project, e.g. per merged PR. */
  dedupeKey?: string;
  provider?: {
    provider: "github" | "gitlab" | "origin";
    changeNumber?: string | null;
    changeUrl?: string | null;
    headSha?: string | null;
    mergeSha?: string | null;
  };
};

/** Where an attachment's object lives: `document-attachments/v1/<p>/<d>/<a>`. */
export type AttachmentKey = {
  projectId: string;
  documentId: string;
  attachmentId: string;
};
/** Server-side object copies for attachments (CopyObject). */
export type AttachmentObjects = {
  copy(from: AttachmentKey, to: AttachmentKey): Promise<void>;
  remove(key: AttachmentKey): Promise<void>;
};

// Per-run bounds; beyond them the UI suggests a smaller selection.
export const MERGE_LIMITS = {
  topLevelItems: 2000,
  childItems: 20000,
  attachmentBytes: 5 * 1024 * 1024 * 1024
};
const EXCERPT = 2000;

type Plan = {
  source: BranchRow;
  target: BranchRow;
  kind: "import" | "merge";
  selection: MergeSelection;
  tasks: { items: TaskPlanItem[]; edges: EdgePlan[] };
  sourceTasks: TaskSide;
  targetTasks: TaskSide;
  documents: DocumentPlanItem[];
  folders: string[];
  sourceDocuments: DocumentSide;
  targetDocuments: DocumentSide;
  chats: ChatPlanItem[];
  sourceChats: ChatSide;
  preview: MergePreview;
};

const everything: MergeSelection = {
  tasks: "all",
  documents: "all",
  chats: "all"
};

const pick = (values: Record<string, unknown>, fields: string[]) =>
  Object.fromEntries(
    fields.map((field) => {
      const value = values[field];
      return [
        field,
        typeof value === "string" && value.length > EXCERPT
          ? `${value.slice(0, EXCERPT)}…`
          : value
      ];
    })
  );

const bump = (counts: Counts, key: string, by = 1) => {
  if (by) counts[key] = (counts[key] ?? 0) + by;
};

// Items whose values a preview shows next to each other.
const shows = (outcome: string) =>
  outcome === "conflict" || outcome === "apply" || outcome === "skipped";

export function runJson(run: RunRow): MergeRun {
  const result = run.result as {
    counts?: Counts;
    skipped?: Skipped;
    decision_count?: number;
  };
  return {
    id: run.id,
    project_id: run.projectId,
    source_branch_id: run.sourceBranchId,
    target_branch_id: run.targetBranchId,
    kind: run.kind,
    trigger: run.trigger,
    status: run.status,
    skip_reason: run.skipReason ?? null,
    provider: run.provider
      ? {
          provider: run.provider,
          change_number: run.providerChangeNumber,
          change_url: run.providerChangeUrl,
          head_sha: run.providerHeadSha,
          merge_sha: run.providerMergeSha
        }
      : null,
    counts: result.counts ?? {},
    skipped: result.skipped ?? [],
    decision_count: result.decision_count ?? 0,
    created_by:
      run.createdByType === "human" && run.createdByUserId
        ? { type: "human", id: run.createdByUserId }
        : null,
    created_at: run.createdAt.toISOString(),
    applied_at: run.appliedAt?.toISOString() ?? null
  };
}

export class MergeEngine {
  constructor(
    private readonly db: Database,
    private readonly branches: BranchService,
    private readonly objects?: AttachmentObjects,
    /** The project attachment quota, as in AttachmentService. */
    private readonly attachmentQuotaBytes = DEFAULT_ATTACHMENT_QUOTA_BYTES
  ) {}

  async preview(projectId: string, request: MergeRequest) {
    return (await this.plan(this.db, projectId, request)).preview;
  }

  private async plan(
    db: Executor,
    projectId: string,
    request: MergeRequest
  ): Promise<Plan> {
    if (request.sourceBranchId === request.targetBranchId)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Choose two different branches.",
        { reason: "same_branch" }
      );
    const branchOf = async (id: string) => {
      const branch = await findProjectBranch(db, projectId, id);
      if (!branch)
        throw new ApiError(404, "BRANCH_NOT_FOUND", "Branch not found.", {
          branch_id: id
        });
      return branch;
    };
    const source = await branchOf(request.sourceBranchId);
    const target = await branchOf(request.targetBranchId);
    const selection: MergeSelection =
      request.kind === "merge"
        ? everything
        : {
            tasks: request.selection?.tasks ?? [],
            documents: request.selection?.documents ?? [],
            chats: request.selection?.chats ?? []
          };
    const sourceIsLow = source.id < target.id;
    const baselines = (itemType: MergeItemType) =>
      loadBaselines(db, source.id, target.id, itemType);

    const sourceTasks = await loadTaskSide(db, source.id);
    const targetTasks = await loadTaskSide(db, target.id);
    const tasks = planTasks({
      kind: request.kind,
      selection: selection.tasks,
      source: sourceTasks,
      target: targetTasks,
      baselines: await baselines("task"),
      claimedTargetIds: await activelyClaimedTaskIds(db, target.id)
    });
    const sourceDocuments = await loadDocumentSide(db, source.id);
    const targetDocuments = await loadDocumentSide(db, target.id);
    const documentBaselines = await baselines("document");
    const documents = planDocuments({
      kind: request.kind,
      selection: selection.documents,
      source: sourceDocuments,
      target: targetDocuments,
      baselines: documentBaselines,
      sourceIsLow
    });
    const folders = planFolders(
      { source: sourceDocuments, target: targetDocuments, kind: request.kind },
      documents
        .filter((item) => item.outcome !== "skipped")
        .map((item) => item.source)
    );
    const sourceChats = await loadChatSide(db, source.id);
    const targetChats = await loadChatSide(db, target.id);
    const chatBaselines = await baselines("chat");
    const chats = planChats({
      selection: selection.chats,
      source: sourceChats,
      target: targetChats,
      baselines: chatBaselines,
      sourceIsLow
    });

    const topLevel = tasks.items.length + documents.length + chats.length;
    const children =
      tasks.items.reduce((total, item) => total + item.comments.length, 0) +
      chats.reduce((total, item) => total + item.messages.length, 0);
    const attachmentBytes = documents.reduce(
      (total, item) =>
        total +
        item.attachments.reduce(
          (sum, attachment) => sum + attachment.sizeBytes,
          0
        ),
      0
    );
    if (
      topLevel > MERGE_LIMITS.topLevelItems ||
      children > MERGE_LIMITS.childItems ||
      attachmentBytes > MERGE_LIMITS.attachmentBytes
    )
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Too much to bring over at once. Select fewer items.",
        { reason: "too_large" }
      );

    const names = await this.participantNames(db, sourceChats, chats);
    const items: MergePreviewItem[] = [
      ...tasks.items.map((item): MergePreviewItem => ({
        item_type: "task",
        lineage_key: item.lineage,
        source_id: item.source.id,
        target_id: item.target?.id ?? null,
        outcome: item.outcome,
        reason: item.reason,
        fields: item.fields,
        required_by: item.requiredBy,
        label: item.source.title,
        task_key: item.source.taskKey,
        audience: null,
        source_values: shows(item.outcome)
          ? pick(taskValues(item.source), item.fields)
          : null,
        target_values:
          shows(item.outcome) && item.target
            ? pick(taskValues(item.target), item.fields)
            : null
      })),
      ...documents.map((item): MergePreviewItem => ({
        item_type: "document",
        lineage_key: item.lineage,
        source_id: item.source.id,
        target_id: item.target?.id ?? null,
        outcome: item.outcome,
        reason: item.reason,
        fields: item.fields,
        required_by: [],
        label: item.source.path,
        task_key: null,
        audience: null,
        source_values: shows(item.outcome)
          ? pick(documentValues(sourceDocuments, item.source), item.fields)
          : null,
        target_values:
          shows(item.outcome) && item.target
            ? pick(documentValues(targetDocuments, item.target), item.fields)
            : null
      })),
      ...chats.map((item): MergePreviewItem => ({
        item_type: "chat",
        lineage_key: item.lineage,
        source_id: item.source.id,
        target_id: item.target?.id ?? null,
        outcome: item.outcome,
        reason: item.reason,
        fields: item.fields,
        required_by: [],
        label: item.source.name ?? "Direct message",
        task_key: null,
        audience: [...audience(sourceChats, item.source)]
          .filter((ref) => ref !== "*humans")
          .map((ref) => {
            const [type, id] = ref.split(":") as ["human" | "agent", string];
            return { type, id, name: names.get(ref) ?? "Unknown" };
          }),
        source_values: shows(item.outcome)
          ? pick(chatValues(item.source), item.fields)
          : null,
        target_values:
          shows(item.outcome) && item.target
            ? pick(chatValues(item.target), item.fields)
            : null
      }))
    ];
    const counts: Counts = {};
    for (const item of tasks.items) {
      bump(counts, `task.${item.outcome}`);
      bump(counts, "task_comment.copy", item.comments.length);
    }
    for (const edge of tasks.edges)
      bump(counts, `task_dependency.${edge.outcome}`);
    for (const item of documents) {
      bump(counts, `document.${item.outcome}`);
      bump(counts, "document_attachment.copy", item.attachments.length);
    }
    bump(counts, "document_folder.copy", folders.length);
    for (const item of chats) {
      bump(counts, `chat.${item.outcome}`);
      bump(counts, "chat_message.copy", item.messages.length);
    }
    // Covers every version the apply depends on, so any change in between
    // makes the preview stale.
    const taskBaselines = await baselines("task");
    const fingerprint = digest({
      kind: request.kind,
      source: source.id,
      target: target.id,
      tasks: tasks.items.map((item) => [
        item.lineage,
        item.source.version,
        item.target?.version ?? null,
        item.outcome,
        item.reason,
        item.fields,
        item.requiredBy,
        item.comments.map(lineageOf),
        taskBaselines.get(item.lineage)?.updatedAt.toISOString() ?? null
      ]),
      edges: tasks.edges.map((edge) => [
        edge.taskLineage,
        edge.blockerLineage,
        edge.outcome
      ]),
      documents: documents.map((item) => [
        item.lineage,
        item.source.currentRevision,
        item.source.updatedAt.toISOString(),
        item.target?.currentRevision ?? null,
        item.target?.updatedAt.toISOString() ?? null,
        item.outcome,
        item.reason,
        item.fields,
        item.attachments.map(lineageOf),
        documentBaselines.get(item.baselineKey)?.updatedAt.toISOString() ?? null
      ]),
      folders,
      chats: chats.map((item) => [
        item.lineage,
        item.source.lastSequence,
        item.source.updatedAt.toISOString(),
        item.target?.lastSequence ?? null,
        item.target?.updatedAt.toISOString() ?? null,
        item.outcome,
        item.reason,
        item.fields,
        item.messages.map(lineageOf),
        chatBaselines.get(item.baselineKey)?.updatedAt.toISOString() ?? null
      ])
    });
    return {
      source,
      target,
      kind: request.kind,
      selection,
      tasks,
      sourceTasks,
      targetTasks,
      documents,
      folders,
      sourceDocuments,
      targetDocuments,
      chats,
      sourceChats,
      preview: {
        fingerprint,
        kind: request.kind,
        source_branch_id: source.id,
        target_branch_id: target.id,
        items,
        counts
      }
    };
  }

  private async participantNames(
    db: Executor,
    side: ChatSide,
    items: ChatPlanItem[]
  ) {
    const participants = items.flatMap(
      (item) => side.participants.get(item.source.id) ?? []
    );
    const userIds = [
      ...new Set(
        participants.flatMap((row) => (row.userId ? [row.userId] : []))
      )
    ];
    const agentIds = [
      ...new Set(
        participants.flatMap((row) => (row.agentId ? [row.agentId] : []))
      )
    ];
    const names = new Map<string, string>();
    if (userIds.length)
      for (const row of await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, userIds)))
        names.set(`human:${row.id}`, row.name);
    if (agentIds.length)
      for (const row of await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, agentIds)))
        names.set(`agent:${row.id}`, row.name);
    return names;
  }

  async apply(
    projectId: string,
    request: ApplyRequest
  ): Promise<{ status: number; body: { run: MergeRun } }> {
    // A finished run replays without copying anything.
    const finished = await this.finished(projectId, request);
    if (finished) return finished;
    // Attachment objects are copied before the transaction so it never waits
    // on storage; copies that end up unused are deleted afterwards.
    const outside = await this.plan(this.db, projectId, request);
    const allocation = allocate(outside.documents);
    const copied: AttachmentCopy[] = [];
    try {
      for (const copy of allocation.attachments)
        await this.copyObject(projectId, copy, copied);
      return await this.db.transaction((tx) =>
        this.applyLocked(tx, projectId, request, allocation, copied)
      );
    } finally {
      await this.cleanup(copied);
    }
  }

  private async finished(projectId: string, request: ApplyRequest) {
    if (request.idempotencyKey && request.userId) {
      const [existing] = await this.db
        .select()
        .from(apiIdempotencyKeys)
        .where(
          and(
            eq(apiIdempotencyKeys.userId, request.userId),
            isNull(apiIdempotencyKeys.agentId),
            eq(apiIdempotencyKeys.operation, "branch_apply"),
            eq(apiIdempotencyKeys.resourceId, request.targetBranchId),
            eq(apiIdempotencyKeys.idempotencyKey, request.idempotencyKey)
          )
        )
        .limit(1);
      if (existing && existing.responseStatus !== 0) {
        if (existing.requestHash !== digest(request))
          throw new ApiError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used with a different request."
          );
        return {
          status: existing.responseStatus,
          body: existing.responseBody as { run: MergeRun }
        };
      }
    }
    if (request.dedupeKey) {
      const [existing] = await this.db
        .select()
        .from(branchMergeRuns)
        .where(
          and(
            eq(branchMergeRuns.projectId, projectId),
            eq(branchMergeRuns.dedupeKey, request.dedupeKey)
          )
        )
        .limit(1);
      if (existing) return { status: 200, body: { run: runJson(existing) } };
    }
    return null;
  }

  private async copyObject(
    projectId: string,
    copy: AttachmentCopy,
    copied: AttachmentCopy[]
  ) {
    if (!this.objects)
      throw new ApiError(
        503,
        "STORAGE_UPLOAD_FAILED",
        "Private attachment storage is not configured."
      );
    await this.objects.copy(
      {
        projectId,
        documentId: copy.source.documentId,
        attachmentId: copy.source.id
      },
      { projectId, documentId: copy.documentId, attachmentId: copy.id }
    );
    copied.push(copy);
  }

  // Deletes copied objects whose attachment rows don't exist (a failed or
  // replayed apply), the same pattern document writes use.
  private async cleanup(copied: AttachmentCopy[]) {
    if (!copied.length || !this.objects) return;
    const kept = new Set(
      (
        await this.db
          .select({ id: documentAttachments.id })
          .from(documentAttachments)
          .where(
            inArray(
              documentAttachments.id,
              copied.map((copy) => copy.id)
            )
          )
      ).map((row) => row.id)
    );
    for (const copy of copied)
      if (!kept.has(copy.id))
        await this.objects
          .remove({
            projectId: copy.source.projectId,
            documentId: copy.documentId,
            attachmentId: copy.id
          })
          .catch(() => undefined);
  }

  private async applyLocked(
    tx: Transaction,
    projectId: string,
    request: ApplyRequest,
    allocation: ReturnType<typeof allocate>,
    copied: AttachmentCopy[]
  ): Promise<{ status: number; body: { run: MergeRun } }> {
    await this.branches.lockActiveProject(tx, projectId);
    const target = await this.branches.lockBranch(
      tx,
      projectId,
      request.targetBranchId
    );
    assertBranchWritable(target, { branchId: target.id });

    const requestHash = digest(request);
    if (request.idempotencyKey) {
      const replay = await this.reserve(tx, request, requestHash);
      if (replay) return replay;
    }
    if (request.dedupeKey) {
      const [existing] = await tx
        .select()
        .from(branchMergeRuns)
        .where(
          and(
            eq(branchMergeRuns.projectId, projectId),
            eq(branchMergeRuns.dedupeKey, request.dedupeKey)
          )
        )
        .limit(1);
      if (existing) return { status: 200, body: { run: runJson(existing) } };
    }

    const plan = await this.plan(tx, projectId, request);
    if (
      request.previewFingerprint &&
      plan.preview.fingerprint !== request.previewFingerprint
    )
      throw new ApiError(
        409,
        "BRANCH_PREVIEW_STALE",
        "The branches changed since the preview. Review the new preview.",
        { preview: plan.preview }
      );
    const choices = request.choices ?? {};
    if (request.kind === "import") {
      const missing = plan.preview.items
        .filter(
          (item) => item.outcome === "conflict" && !choices[item.lineage_key]
        )
        .map((item) => item.lineage_key);
      if (missing.length)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Choose which version to keep for every conflict.",
          { reason: "missing_choice", lineage_keys: missing }
        );
    }
    if (request.archiveSource && plan.source.isDefault)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "The default branch cannot be archived.",
        { reason: "default_branch" }
      );
    await this.assertQuota(tx, projectId, plan);

    const now = new Date();
    const [run] = await tx
      .insert(branchMergeRuns)
      .values({
        projectId,
        sourceBranchId: plan.source.id,
        targetBranchId: plan.target.id,
        kind: request.kind,
        trigger: request.trigger,
        status: "applied",
        dedupeKey: request.dedupeKey ?? null,
        provider: request.provider?.provider ?? null,
        providerChangeNumber: request.provider?.changeNumber ?? null,
        providerChangeUrl: request.provider?.changeUrl ?? null,
        providerHeadSha: request.provider?.headSha ?? null,
        providerMergeSha: request.provider?.mergeSha ?? null,
        selection: { selection: plan.selection, choices },
        createdByType: request.userId ? "human" : null,
        createdByUserId: request.userId
      })
      .returning();
    const context = { tx, plan, runId: run!.id, choices, now };
    // Dependency order: folders and documents first, so chat messages can
    // point at the target's copies.
    const documents = await this.applyDocuments(context, allocation, copied);
    const tasks = await this.applyTasks(context);
    const chats = await this.applyChats(context, documents.landed);
    const skipped = [...documents.skipped, ...tasks.skipped, ...chats.skipped];
    const decisions = documents.decisions + tasks.decisions + chats.decisions;
    const [applied] = await tx
      .update(branchMergeRuns)
      .set({
        status: decisions ? "applied_with_decisions" : "applied",
        result: {
          counts: plan.preview.counts,
          skipped,
          decision_count: decisions
        },
        appliedAt: now
      })
      .where(eq(branchMergeRuns.id, run!.id))
      .returning();

    const actor = request.userId
      ? { type: "human" as const, id: request.userId }
      : null;
    if (request.archiveSource)
      await this.branches.archiveInTransaction(tx, plan.source, {
        reason: "manual",
        userId: request.userId
      });
    if (request.completeOnboarding)
      await this.branches.markOnboarded(
        tx,
        plan.target,
        request.kind === "import" &&
          Object.values(plan.selection).some((value) => value !== "all")
          ? "selected"
          : "import_all",
        actor
      );
    // One summary event per run, never one per item.
    await insertProjectEvent(tx, {
      projectId,
      branchId: plan.target.id,
      actorUserId: request.userId,
      entityId: applied!.id,
      type:
        request.kind === "import"
          ? "merge.import_applied"
          : "merge.merge_applied",
      payload: {
        run_id: applied!.id,
        source_branch_id: plan.source.id,
        counts: plan.preview.counts,
        decision_count: decisions
      }
    });
    if (decisions)
      await insertProjectEvent(tx, {
        projectId,
        branchId: plan.target.id,
        actorUserId: request.userId,
        entityId: applied!.id,
        type: "decision.opened",
        payload: { run_id: applied!.id, count: decisions }
      });
    const body = { run: runJson(applied!) };
    if (request.idempotencyKey)
      await tx
        .update(apiIdempotencyKeys)
        .set({ responseStatus: 201, responseBody: body })
        .where(
          and(
            eq(apiIdempotencyKeys.userId, request.userId!),
            eq(apiIdempotencyKeys.operation, "branch_apply"),
            eq(apiIdempotencyKeys.resourceId, plan.target.id),
            eq(apiIdempotencyKeys.idempotencyKey, request.idempotencyKey)
          )
        );
    return { status: 201, body };
  }

  // Dashboard applies replay a lost response by Idempotency-Key, scoped to
  // the target branch.
  private async reserve(
    tx: Transaction,
    request: ApplyRequest,
    requestHash: string
  ) {
    if (!request.userId)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Only people apply with an Idempotency-Key."
      );
    const key = {
      userId: request.userId,
      operation: "branch_apply",
      resourceId: request.targetBranchId,
      idempotencyKey: request.idempotencyKey!
    };
    const [reserved] = await tx
      .insert(apiIdempotencyKeys)
      .values({ ...key, requestHash, responseStatus: 0, responseBody: {} })
      .onConflictDoNothing()
      .returning();
    if (reserved) return null;
    const [existing] = await tx
      .select()
      .from(apiIdempotencyKeys)
      .where(
        and(
          eq(apiIdempotencyKeys.userId, key.userId),
          isNull(apiIdempotencyKeys.agentId),
          eq(apiIdempotencyKeys.operation, key.operation),
          eq(apiIdempotencyKeys.resourceId, key.resourceId),
          eq(apiIdempotencyKeys.idempotencyKey, key.idempotencyKey)
        )
      )
      .limit(1);
    if (!existing || existing.requestHash !== requestHash)
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used with a different request."
      );
    return {
      status: existing.responseStatus,
      body: existing.responseBody as { run: MergeRun }
    };
  }

  // Copies count toward the project's attachment quota.
  private async assertQuota(tx: Transaction, projectId: string, plan: Plan) {
    const incoming = plan.documents
      .filter((item) => item.outcome !== "skipped")
      .flatMap((item) => item.attachments)
      .reduce((total, attachment) => total + attachment.sizeBytes, 0);
    if (!incoming) return;
    const [stored] = await tx
      .select({
        value: sql<string>`coalesce(sum(${documentAttachments.sizeBytes}), 0)`
      })
      .from(documentAttachments)
      .where(eq(documentAttachments.projectId, projectId));
    const [reserved] = await tx
      .select({
        value: sql<string>`coalesce(sum(${documentAttachmentUploads.reservedBytes}), 0)`
      })
      .from(documentAttachmentUploads)
      .where(
        and(
          eq(documentAttachmentUploads.projectId, projectId),
          eq(documentAttachmentUploads.status, "pending"),
          gt(documentAttachmentUploads.expiresAt, new Date())
        )
      );
    if (
      Number(stored?.value ?? 0) + Number(reserved?.value ?? 0) + incoming >
      this.attachmentQuotaBytes
    )
      throw new ApiError(
        409,
        "ATTACHMENT_QUOTA_EXCEEDED",
        "Project attachment quota exceeded."
      );
  }

  private baseline(
    context: Context,
    itemType: MergeItemType,
    lineageKey: string,
    fingerprint: Fingerprint
  ) {
    return upsertBaseline(context.tx, {
      projectId: context.plan.target.projectId,
      a: context.plan.source.id,
      b: context.plan.target.id,
      itemType,
      lineageKey,
      fingerprint,
      runId: context.runId
    });
  }

  private inherit(
    context: Context,
    itemType: MergeItemType,
    lineageKey: string,
    fingerprint: Fingerprint
  ) {
    return inheritBaselines(context.tx, {
      projectId: context.plan.target.projectId,
      source: context.plan.source.id,
      target: context.plan.target.id,
      itemType,
      lineageKey,
      fingerprint,
      runId: context.runId
    });
  }

  /** Whether an item's source values land: merges apply, imports choose. */
  private lands(context: Context, item: { outcome: string; lineage: string }) {
    return (
      item.outcome === "apply" ||
      (item.outcome === "conflict" &&
        context.plan.kind === "import" &&
        context.choices[item.lineage] === "use_source")
    );
  }

  /** The agreed state moves to the source's unless the target was kept
   * because only it changed, or a merge is waiting for a decision. */
  private agrees(context: Context, item: { outcome: string }) {
    return (
      item.outcome === "apply" ||
      item.outcome === "unchanged" ||
      (item.outcome === "conflict" && context.plan.kind === "import")
    );
  }

  private async applyDocuments(
    context: Context,
    allocation: ReturnType<typeof allocate>,
    copied: AttachmentCopy[]
  ) {
    const { tx, plan, now } = context;
    const skipped: Skipped = [];
    let decisions = 0;
    await insertFolders(tx, {
      projectId: plan.target.projectId,
      branchId: plan.target.id,
      paths: plan.folders
    });
    // Reuse the ids whose objects were copied before the transaction.
    const preallocated = new Map(
      allocation.attachments.map((copy) => [copy.source.id, copy])
    );
    const landed = new Map<string, DocumentRow>(plan.targetDocuments.byLineage);
    for (const item of plan.documents) {
      if (item.outcome === "skipped") {
        skipped.push({
          item_type: "document",
          lineage_key: item.lineage,
          label: item.source.path,
          reason: item.reason!
        });
        continue;
      }
      const documentId =
        item.target?.id ??
        allocation.documentIds.get(item.source.id) ??
        randomUUID();
      const copies: AttachmentCopy[] = [];
      for (const attachment of item.attachments) {
        const ready = preallocated.get(attachment.id);
        if (ready && ready.documentId === documentId) copies.push(ready);
        else {
          const copy = {
            source: attachment,
            id: randomUUID(),
            documentId
          };
          await this.copyObject(plan.target.projectId, copy, copied);
          copies.push(copy);
        }
      }
      // Body references point at the target's attachments after the copy.
      const refs = new Map<string, string>();
      const byLineage = new Map(
        (plan.targetDocuments.attachments.get(item.target?.id ?? "") ?? []).map(
          (row) => [lineageOf(row), row.id]
        )
      );
      for (const copy of copies) byLineage.set(lineageOf(copy.source), copy.id);
      for (const attachment of plan.sourceDocuments.attachments.get(
        item.source.id
      ) ?? []) {
        const mapped = byLineage.get(lineageOf(attachment));
        if (mapped) refs.set(attachment.id, mapped);
      }
      const values = documentValues(plan.sourceDocuments, item.source);
      if (item.outcome === "copy") {
        const copy = await insertDocumentCopy(tx, {
          source: item.source,
          lineage: item.lineage,
          id: documentId,
          targetBranchId: plan.target.id,
          attachments: copies,
          refs,
          now
        });
        landed.set(item.lineage, copy);
        await this.baseline(
          context,
          "document",
          item.baselineKey,
          item.sourceFingerprint
        );
        await this.inherit(
          context,
          "document",
          item.baselineKey,
          item.sourceFingerprint
        );
        continue;
      }
      await insertAttachments(tx, plan.target.id, copies);
      if (this.lands(context, item)) {
        const updated = await applyDocumentValues(tx, {
          target: item.target!,
          sourceRevision: plan.sourceDocuments.current.get(item.source.id)!,
          values,
          fields: item.fields,
          refs,
          now
        });
        landed.set(lineageOf(updated), updated);
      }
      if (item.outcome === "conflict" && plan.kind === "merge") {
        await this.openDecision(context, {
          itemType: "document",
          lineageKey: lineageOf(item.target!),
          sourceItemId: item.source.id,
          targetItemId: item.target!.id,
          label: item.source.path,
          reason: item.reason!,
          fields: item.fields,
          sourceSnapshot: {
            values: { path: values.path, archived: values.archived },
            revision_id: plan.sourceDocuments.current.get(item.source.id)?.id,
            body_sha256: item.sourceFingerprint.body,
            baseline_key: item.baselineKey
          },
          targetSnapshot: {
            values: {
              path: item.target!.path,
              archived: item.target!.archivedAt !== null
            },
            revision_id: plan.targetDocuments.current.get(item.target!.id)?.id
          },
          targetFingerprint: item.targetFingerprint!
        });
        decisions += 1;
      }
      if (this.agrees(context, item))
        await this.baseline(
          context,
          "document",
          item.baselineKey,
          item.sourceFingerprint
        );
    }
    return { skipped, decisions, landed };
  }

  private async applyTasks(context: Context) {
    const { tx, plan, now } = context;
    const position = columnEnds(plan.targetTasks);
    const landed = new Map<string, TaskRow>(plan.targetTasks.byLineage);
    const skipped: Skipped = [];
    let decisions = 0;
    for (const item of plan.tasks.items) {
      if (item.outcome === "skipped") {
        skipped.push({
          item_type: "task",
          lineage_key: item.lineage,
          label: item.source.title,
          reason: item.reason!
        });
        continue;
      }
      if (item.outcome === "copy") {
        const copy = await insertTaskCopy(tx, {
          source: item.source,
          lineage: item.lineage,
          targetBranchId: plan.target.id,
          position,
          now
        });
        landed.set(item.lineage, copy);
        await copyComments(tx, {
          comments: item.comments,
          targetTask: copy,
          targetLastSequence: 0,
          now
        });
        await this.baseline(
          context,
          "task",
          item.lineage,
          item.sourceFingerprint
        );
        await this.inherit(
          context,
          "task",
          item.lineage,
          item.sourceFingerprint
        );
        continue;
      }
      const targetTask = item.target!;
      if (this.lands(context, item))
        landed.set(
          item.lineage,
          await applyTaskValues(tx, {
            target: targetTask,
            values: taskValues(item.source),
            fields: item.fields,
            position,
            now
          })
        );
      if (item.outcome === "conflict" && plan.kind === "merge") {
        await this.openDecision(context, {
          itemType: "task",
          lineageKey: lineageOf(targetTask),
          sourceItemId: item.source.id,
          targetItemId: targetTask.id,
          label: `${item.source.taskKey} ${item.source.title}`,
          reason: item.reason!,
          fields: item.fields,
          sourceSnapshot: {
            values: taskValues(item.source),
            version: item.source.version,
            baseline_key: item.lineage
          },
          targetSnapshot: {
            values: taskValues(targetTask),
            version: targetTask.version
          },
          targetFingerprint:
            item.targetFingerprint ?? fingerprintOf(taskValues(targetTask))
        });
        decisions += 1;
      }
      await copyComments(tx, {
        comments: item.comments,
        targetTask,
        targetLastSequence:
          plan.targetTasks.comments.get(targetTask.id)?.at(-1)?.sequence ?? 0,
        now
      });
      if (this.agrees(context, item))
        await this.baseline(
          context,
          "task",
          item.lineage,
          item.sourceFingerprint
        );
    }
    for (const edge of plan.tasks.edges) {
      if (edge.outcome === "skipped") {
        skipped.push({
          item_type: "task_dependency",
          lineage_key: edge.taskLineage,
          label: edge.label,
          reason: "dependency_cycle"
        });
        continue;
      }
      await insertEdge(tx, {
        projectId: plan.target.projectId,
        branchId: plan.target.id,
        taskId: landed.get(edge.taskLineage)!.id,
        dependsOnTaskId: landed.get(edge.blockerLineage)!.id
      });
    }
    return { skipped, decisions };
  }

  private async applyChats(
    context: Context,
    documentsByLineage: Map<string, DocumentRow>
  ) {
    const { tx, plan, now } = context;
    const skipped: Skipped = [];
    let decisions = 0;
    // Message document references follow lineage to the target's copies.
    const documentRefs = new Map<string, { id: string; path: string }>();
    for (const document of plan.sourceDocuments.documents) {
      const landed = documentsByLineage.get(lineageOf(document));
      if (landed)
        documentRefs.set(document.id, { id: landed.id, path: landed.path });
    }
    for (const item of plan.chats) {
      if (item.outcome === "skipped") {
        skipped.push({
          item_type: "chat",
          lineage_key: item.lineage,
          label: item.source.name ?? "Direct message",
          reason: item.reason!
        });
        continue;
      }
      if (item.outcome === "copy") {
        await insertChatCopy(tx, {
          source: item.source,
          lineage: item.lineage,
          targetBranchId: plan.target.id,
          participants: plan.sourceChats.participants.get(item.source.id) ?? [],
          messages: item.messages,
          documentRefs,
          now
        });
        await this.baseline(
          context,
          "chat",
          item.baselineKey,
          item.sourceFingerprint
        );
        await this.inherit(
          context,
          "chat",
          item.baselineKey,
          item.sourceFingerprint
        );
        continue;
      }
      const target = item.target!;
      const set: Partial<ChatRow> = {};
      if (this.lands(context, item)) set.name = item.source.name;
      if (item.messages.length)
        // Imported history keeps the chat's place in lists: no updated_at.
        set.lastSequence = await insertMessages(tx, {
          chat: target,
          messages: item.messages,
          keepSequences: false,
          documentRefs,
          now
        });
      if (Object.keys(set).length)
        await tx.update(chatTable).set(set).where(eq(chatTable.id, target.id));
      if (item.outcome === "conflict" && plan.kind === "merge") {
        await this.openDecision(context, {
          itemType: "chat",
          lineageKey: lineageOf(target),
          sourceItemId: item.source.id,
          targetItemId: target.id,
          label: item.source.name ?? "Direct message",
          // Chats conflict only on their name.
          reason: "changed_on_both",
          fields: item.fields,
          sourceSnapshot: {
            values: chatValues(item.source),
            baseline_key: item.baselineKey
          },
          targetSnapshot: { values: chatValues(target) },
          targetFingerprint: item.targetFingerprint!
        });
        decisions += 1;
      }
      if (this.agrees(context, item))
        await this.baseline(
          context,
          "chat",
          item.baselineKey,
          item.sourceFingerprint
        );
    }
    return { skipped, decisions };
  }

  // A newer merge of the same item supersedes its older open decision.
  private async openDecision(
    context: Context,
    decision: {
      itemType: MergeItemType;
      lineageKey: string;
      sourceItemId: string;
      targetItemId: string;
      label: string;
      reason:
        | "changed_on_both"
        | "added_on_both"
        | "path_collision"
        | "target_claimed";
      fields: string[];
      sourceSnapshot: Record<string, unknown>;
      targetSnapshot: Record<string, unknown>;
      targetFingerprint: Fingerprint;
    }
  ) {
    const { tx, plan, runId } = context;
    await tx
      .update(branchMergeDecisions)
      .set({ status: "superseded", resolvedAt: new Date() })
      .where(
        and(
          eq(branchMergeDecisions.targetBranchId, plan.target.id),
          eq(branchMergeDecisions.itemType, decision.itemType),
          eq(branchMergeDecisions.lineageKey, decision.lineageKey),
          eq(branchMergeDecisions.status, "open")
        )
      );
    await tx.insert(branchMergeDecisions).values({
      projectId: plan.target.projectId,
      runId,
      sourceBranchId: plan.source.id,
      targetBranchId: plan.target.id,
      ...decision
    });
  }
}

type Context = {
  tx: Transaction;
  plan: Plan;
  runId: string;
  choices: Record<string, MergeChoice>;
  now: Date;
};
