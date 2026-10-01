import {
  apiIdempotencyKeys,
  branchMergeDecisions,
  branchMergeRuns,
  type Database
} from "@orchestrat/db";
import type {
  MergeChoice,
  MergePreview,
  MergePreviewItem,
  MergeRun,
  MergeSelection
} from "@orchestrat/protocol";
import { and, eq, isNull } from "drizzle-orm";
import { insertProjectEvent } from "../agent-service.js";
import { ApiError } from "../api-error.js";
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
  type Baseline,
  type Executor
} from "./baselines.js";
import { digest, fingerprintOf } from "./fingerprint.js";
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

// One engine for imports, manual merges and provider merges
// (docs/project-branches.md §9). plan() reads without locks; apply() re-plans
// under the project lock and writes everything in one transaction.

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

// Per-run bounds (spec §9.5); beyond them the UI suggests a smaller selection.
export const MERGE_LIMITS = { topLevelItems: 2000, childItems: 20000 };

type Plan = {
  source: BranchRow;
  target: BranchRow;
  kind: "import" | "merge";
  selection: MergeSelection;
  tasks: { items: TaskPlanItem[]; edges: EdgePlan[] };
  taskBaselines: Map<string, Baseline>;
  sourceTasks: TaskSide;
  targetTasks: TaskSide;
  preview: MergePreview;
};

const everything: MergeSelection = {
  tasks: "all",
  documents: "all",
  chats: "all"
};

const pick = (values: Record<string, unknown>, fields: string[]) =>
  Object.fromEntries(fields.map((field) => [field, values[field]]));

const bump = (counts: Counts, key: string, by = 1) => {
  if (by) counts[key] = (counts[key] ?? 0) + by;
};

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
    private readonly branches: BranchService
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
    const [source, target] = await Promise.all(
      [request.sourceBranchId, request.targetBranchId].map(async (id) => {
        const branch = await findProjectBranch(db, projectId, id);
        if (!branch)
          throw new ApiError(404, "BRANCH_NOT_FOUND", "Branch not found.", {
            branch_id: id
          });
        return branch;
      })
    );
    const selection: MergeSelection =
      request.kind === "merge"
        ? everything
        : {
            tasks: request.selection?.tasks ?? [],
            documents: request.selection?.documents ?? [],
            chats: request.selection?.chats ?? []
          };
    const sourceTasks = await loadTaskSide(db, source!.id);
    const targetTasks = await loadTaskSide(db, target!.id);
    const taskBaselines = await loadBaselines(
      db,
      source!.id,
      target!.id,
      "task"
    );
    const claimed = await activelyClaimedTaskIds(db, target!.id);
    const tasks = planTasks({
      kind: request.kind,
      selection: selection.tasks,
      source: sourceTasks,
      target: targetTasks,
      baselines: taskBaselines,
      claimedTargetIds: claimed
    });
    const children = tasks.items.reduce(
      (total, item) => total + item.comments.length,
      0
    );
    if (
      tasks.items.length > MERGE_LIMITS.topLevelItems ||
      children > MERGE_LIMITS.childItems
    )
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Too much to bring over at once. Select fewer items.",
        { reason: "too_large" }
      );
    const items: MergePreviewItem[] = tasks.items.map((item) => {
      const shown =
        item.outcome === "conflict" ||
        item.outcome === "apply" ||
        item.outcome === "skipped";
      return {
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
        source_values: shown
          ? pick(taskValues(item.source), item.fields)
          : null,
        target_values:
          shown && item.target
            ? pick(taskValues(item.target), item.fields)
            : null
      };
    });
    const counts: Counts = {};
    for (const item of tasks.items) {
      bump(counts, `task.${item.outcome}`);
      bump(counts, "task_comment.copy", item.comments.length);
    }
    for (const edge of tasks.edges)
      bump(counts, `task_dependency.${edge.outcome}`);
    // Covers every version the apply depends on, so any change in between
    // makes the preview stale (spec §9.7).
    const fingerprint = digest({
      kind: request.kind,
      source: source!.id,
      target: target!.id,
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
      ])
    });
    return {
      source: source!,
      target: target!,
      kind: request.kind,
      selection,
      tasks,
      taskBaselines,
      sourceTasks,
      targetTasks,
      preview: {
        fingerprint,
        kind: request.kind,
        source_branch_id: source!.id,
        target_branch_id: target!.id,
        items,
        counts
      }
    };
  }

  async apply(
    projectId: string,
    request: ApplyRequest
  ): Promise<{ status: number; body: { run: MergeRun } }> {
    return this.db.transaction(async (tx) => {
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
        const missing = plan.tasks.items
          .filter(
            (item) => item.outcome === "conflict" && !choices[item.lineage]
          )
          .map((item) => item.lineage);
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
      const result = await this.applyTasks(tx, plan, run!.id, choices, now);
      const [applied] = await tx
        .update(branchMergeRuns)
        .set({
          status: result.decisions ? "applied_with_decisions" : "applied",
          result: {
            counts: plan.preview.counts,
            skipped: result.skipped,
            decision_count: result.decisions
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
      // One summary event per run, never one per item (spec §9.7).
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
          decision_count: result.decisions
        }
      });
      if (result.decisions)
        await insertProjectEvent(tx, {
          projectId,
          branchId: plan.target.id,
          actorUserId: request.userId,
          entityId: applied!.id,
          type: "decision.opened",
          payload: { run_id: applied!.id, count: result.decisions }
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
    });
  }

  // Dashboard applies replay a lost response by Idempotency-Key, scoped to
  // the target branch (spec §6.5).
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

  private async applyTasks(
    tx: Transaction,
    plan: Plan,
    runId: string,
    choices: Record<string, MergeChoice>,
    now: Date
  ) {
    const { source, target } = plan;
    const position = columnEnds(plan.targetTasks);
    const landed = new Map<string, TaskRow>(plan.targetTasks.byLineage);
    const skipped: Skipped = [];
    let decisions = 0;
    const baseline = (lineage: string, fingerprint: Record<string, string>) =>
      upsertBaseline(tx, {
        projectId: target.projectId,
        a: source.id,
        b: target.id,
        itemType: "task",
        lineageKey: lineage,
        fingerprint,
        runId
      });

    for (const item of plan.tasks.items) {
      const values = taskValues(item.source);
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
          targetBranchId: target.id,
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
        await baseline(item.lineage, item.sourceFingerprint);
        await inheritBaselines(tx, {
          projectId: target.projectId,
          source: source.id,
          target: target.id,
          itemType: "task",
          lineageKey: item.lineage,
          fingerprint: item.sourceFingerprint,
          runId
        });
        continue;
      }
      const targetTask = item.target!;
      const choice = plan.kind === "import" ? choices[item.lineage] : undefined;
      if (item.outcome === "apply" || choice === "use_source")
        landed.set(
          item.lineage,
          await applyTaskValues(tx, {
            target: targetTask,
            values,
            fields: item.fields,
            position,
            now
          })
        );
      if (item.outcome === "conflict" && plan.kind === "merge") {
        await this.openDecision(tx, plan, runId, item);
        decisions += 1;
      }
      const lastSequence =
        plan.targetTasks.comments.get(targetTask.id)?.at(-1)?.sequence ?? 0;
      await copyComments(tx, {
        comments: item.comments,
        targetTask,
        targetLastSequence: lastSequence,
        now
      });
      // The agreed state moves to the source's unless the target was kept
      // because only it changed, or a merge is waiting for a decision.
      if (
        item.outcome === "apply" ||
        item.outcome === "unchanged" ||
        (item.outcome === "conflict" && plan.kind === "import")
      )
        await baseline(item.lineage, item.sourceFingerprint);
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
        projectId: target.projectId,
        branchId: target.id,
        taskId: landed.get(edge.taskLineage)!.id,
        dependsOnTaskId: landed.get(edge.blockerLineage)!.id
      });
    }
    return { skipped, decisions };
  }

  // A newer merge of the same item supersedes its older open decision.
  private async openDecision(
    tx: Transaction,
    plan: Plan,
    runId: string,
    item: TaskPlanItem
  ) {
    const now = new Date();
    await tx
      .update(branchMergeDecisions)
      .set({ status: "superseded", resolvedAt: now })
      .where(
        and(
          eq(branchMergeDecisions.targetBranchId, plan.target.id),
          eq(branchMergeDecisions.itemType, "task"),
          eq(branchMergeDecisions.lineageKey, lineageOf(item.target!)),
          eq(branchMergeDecisions.status, "open")
        )
      );
    await tx.insert(branchMergeDecisions).values({
      projectId: plan.target.projectId,
      runId,
      sourceBranchId: plan.source.id,
      targetBranchId: plan.target.id,
      itemType: "task",
      lineageKey: lineageOf(item.target!),
      sourceItemId: item.source.id,
      targetItemId: item.target!.id,
      label: `${item.source.taskKey} ${item.source.title}`,
      reason: item.reason!,
      fields: item.fields,
      sourceSnapshot: {
        values: taskValues(item.source),
        version: item.source.version
      },
      targetSnapshot: {
        values: taskValues(item.target!),
        version: item.target!.version
      },
      targetFingerprint:
        item.targetFingerprint ?? fingerprintOf(taskValues(item.target!))
    });
  }
}
