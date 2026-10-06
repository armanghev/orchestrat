import {
  taskClaims,
  taskComments,
  taskDependencies,
  tasks,
  type Database
} from "@orchestrat/db";
import { and, asc, eq } from "drizzle-orm";
import { resetsToReadyOnClaimEnd } from "../task-block-hooks.js";
import type { Baseline, Executor } from "./baselines.js";
import {
  changedFields,
  fingerprintOf,
  sameFingerprint,
  type Fingerprint
} from "./fingerprint.js";

// Tasks, their comments and dependencies in the merge engine
// (docs/project-branches.md §9.1–§9.5). Claims, sessions, watches, blocks and
// handoffs are per-agent runtime state and never cross branches.

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type TaskRow = typeof tasks.$inferSelect;
export type CommentRow = typeof taskComments.$inferSelect;
type Edge = { taskId: string; dependsOnTaskId: string };

/** One logical item across branches: the original id, or its copy's origin. */
export const lineageOf = (row: { id: string; originId: string | null }) =>
  row.originId ?? row.id;

export type TaskSide = {
  tasks: TaskRow[];
  byId: Map<string, TaskRow>;
  byLineage: Map<string, TaskRow>;
  /** Comments per task id, in sequence order. */
  comments: Map<string, CommentRow[]>;
  edges: Edge[];
};

export async function loadTaskSide(
  db: Executor,
  branchId: string
): Promise<TaskSide> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.branchId, branchId))
    .orderBy(asc(tasks.taskNumber));
  const commentRows = await db
    .select()
    .from(taskComments)
    .where(eq(taskComments.branchId, branchId))
    .orderBy(asc(taskComments.taskId), asc(taskComments.sequence));
  const edges = await db
    .select({
      taskId: taskDependencies.taskId,
      dependsOnTaskId: taskDependencies.dependsOnTaskId
    })
    .from(taskDependencies)
    .where(eq(taskDependencies.branchId, branchId));
  const comments = new Map<string, CommentRow[]>();
  for (const comment of commentRows)
    comments.set(comment.taskId, [
      ...(comments.get(comment.taskId) ?? []),
      comment
    ]);
  return {
    tasks: rows,
    byId: new Map(rows.map((row) => [row.id, row])),
    byLineage: new Map(rows.map((row) => [lineageOf(row), row])),
    comments,
    edges
  };
}

export async function activelyClaimedTaskIds(db: Executor, branchId: string) {
  const rows = await db
    .select({ taskId: taskClaims.taskId })
    .from(taskClaims)
    .where(
      and(eq(taskClaims.branchId, branchId), eq(taskClaims.status, "active"))
    );
  return new Set(rows.map((row) => row.taskId));
}

/**
 * The compared fields. Claims never cross branches, so a status that only an
 * active claim can hold reads as `ready` for comparing and for writing.
 */
export const taskValues = (task: TaskRow) => ({
  title: task.title,
  description: task.description ?? null,
  priority: task.priority,
  status: resetsToReadyOnClaimEnd(task.status) ? "ready" : task.status
});
export type TaskValues = ReturnType<typeof taskValues>;

export type TaskPlanItem = {
  lineage: string;
  source: TaskRow;
  target: TaskRow | null;
  outcome:
    "copy" | "apply" | "unchanged" | "keep_target" | "conflict" | "skipped";
  reason: "changed_on_both" | "target_claimed" | null;
  fields: string[];
  requiredBy: string[];
  sourceFingerprint: Fingerprint;
  targetFingerprint: Fingerprint | null;
  /** Source comments that will land in the target, in sequence order. */
  comments: CommentRow[];
};

export type EdgePlan = {
  taskLineage: string;
  blockerLineage: string;
  outcome: "copy" | "skipped";
  reason: "dependency_cycle" | null;
  label: string;
};

export function planTasks(input: {
  kind: "import" | "merge";
  selection: "all" | string[];
  source: TaskSide;
  target: TaskSide;
  baselines: Map<string, Baseline>;
  claimedTargetIds: Set<string>;
}): { items: TaskPlanItem[]; edges: EdgePlan[] } {
  const { source, target } = input;
  const blockers = new Map<string, string[]>();
  for (const edge of source.edges)
    blockers.set(edge.taskId, [
      ...(blockers.get(edge.taskId) ?? []),
      edge.dependsOnTaskId
    ]);

  // Selected lineages, each with the selected tasks that require it. A task
  // brings along every blocker the target lacks, transitively (spec §9.5).
  const selected = new Map<string, Set<string>>();
  const roots =
    input.selection === "all"
      ? source.tasks.map(lineageOf)
      : input.selection.filter((lineage) => source.byLineage.has(lineage));
  const queue = [...roots];
  for (const lineage of roots) selected.set(lineage, new Set());
  while (queue.length) {
    const lineage = queue.shift()!;
    const task = source.byLineage.get(lineage)!;
    for (const blockerId of blockers.get(task.id) ?? []) {
      const blocker = source.byId.get(blockerId);
      if (!blocker) continue;
      const blockerLineage = lineageOf(blocker);
      if (target.byLineage.has(blockerLineage)) continue;
      if (!selected.has(blockerLineage)) {
        selected.set(blockerLineage, new Set());
        queue.push(blockerLineage);
      }
      selected.get(blockerLineage)!.add(lineage);
    }
  }

  const items: TaskPlanItem[] = [];
  for (const [lineage, requiredBy] of selected) {
    const sourceTask = source.byLineage.get(lineage)!;
    const targetTask = target.byLineage.get(lineage) ?? null;
    const s = fingerprintOf(taskValues(sourceTask));
    const sourceComments = source.comments.get(sourceTask.id) ?? [];
    const base = {
      lineage,
      source: sourceTask,
      target: targetTask,
      requiredBy: [...requiredBy].sort(),
      sourceFingerprint: s
    };
    if (!targetTask) {
      items.push({
        ...base,
        outcome: "copy",
        reason: null,
        fields: [],
        targetFingerprint: null,
        comments: sourceComments
      });
      continue;
    }
    const t = fingerprintOf(taskValues(targetTask));
    const b = input.baselines.get(lineage)?.fingerprint;
    // Comments are immutable and append-only: copy the ones the target lacks.
    const present = new Set(
      (target.comments.get(targetTask.id) ?? []).map(lineageOf)
    );
    const comments = sourceComments.filter(
      (comment) => !present.has(lineageOf(comment))
    );
    const claimed = input.claimedTargetIds.has(targetTask.id);
    const changedSource = changedFields(s, b);
    const changedTarget = changedFields(t, b);
    if (sameFingerprint(s, t))
      items.push({
        ...base,
        outcome: "unchanged",
        reason: null,
        fields: [],
        targetFingerprint: t,
        comments
      });
    else if (b && changedTarget.length === 0)
      // A claimed task is never modified: merges ask, imports skip.
      items.push(
        claimed && input.kind === "import"
          ? {
              ...base,
              outcome: "skipped",
              reason: "target_claimed",
              fields: changedSource,
              targetFingerprint: t,
              comments: []
            }
          : {
              ...base,
              outcome: claimed ? "conflict" : "apply",
              reason: claimed ? "target_claimed" : null,
              fields: changedSource,
              targetFingerprint: t,
              comments
            }
      );
    else if (b && changedSource.length === 0)
      items.push({
        ...base,
        outcome: "keep_target",
        reason: null,
        fields: [],
        targetFingerprint: t,
        comments
      });
    else
      items.push({
        ...base,
        outcome: "conflict",
        reason: "changed_on_both",
        fields: changedFields(s, t),
        targetFingerprint: t,
        comments
      });
  }
  items.sort((left, right) => left.source.taskNumber - right.source.taskNumber);
  return { items, edges: planEdges(input, items) };
}

// Dependencies are additive: a source edge lands when both ends exist in the
// target afterwards and it closes no cycle there (spec §9.1).
function planEdges(
  input: { source: TaskSide; target: TaskSide },
  items: TaskPlanItem[]
): EdgePlan[] {
  const { source, target } = input;
  const landing = new Set(
    items
      .filter((item) => item.outcome !== "skipped")
      .map((item) => item.lineage)
  );
  const present = new Set([...target.byLineage.keys(), ...landing]);
  const graph = new Map<string, Set<string>>();
  const link = (from: string, to: string) =>
    graph.set(from, (graph.get(from) ?? new Set()).add(to));
  for (const edge of target.edges) {
    const task = target.byId.get(edge.taskId);
    const blocker = target.byId.get(edge.dependsOnTaskId);
    if (task && blocker) link(lineageOf(task), lineageOf(blocker));
  }
  const reaches = (from: string, to: string) => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const next = stack.pop()!;
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(graph.get(next) ?? []));
    }
    return false;
  };
  const candidates = source.edges
    .map((edge) => ({
      task: source.byId.get(edge.taskId)!,
      blocker: source.byId.get(edge.dependsOnTaskId)!
    }))
    .filter(({ task, blocker }) => task && blocker)
    .filter(({ task }) => landing.has(lineageOf(task)))
    .sort(
      (left, right) =>
        left.task.taskNumber - right.task.taskNumber ||
        left.blocker.taskNumber - right.blocker.taskNumber
    );
  const plans: EdgePlan[] = [];
  for (const { task, blocker } of candidates) {
    const taskLineage = lineageOf(task);
    const blockerLineage = lineageOf(blocker);
    if (!present.has(blockerLineage)) continue;
    if (graph.get(taskLineage)?.has(blockerLineage)) continue;
    const label = `${task.taskKey} → ${blocker.taskKey}`;
    if (reaches(blockerLineage, taskLineage)) {
      plans.push({
        taskLineage,
        blockerLineage,
        outcome: "skipped",
        reason: "dependency_cycle",
        label
      });
      continue;
    }
    link(taskLineage, blockerLineage);
    plans.push({
      taskLineage,
      blockerLineage,
      outcome: "copy",
      reason: null,
      label
    });
  }
  return plans;
}

/** Columns keep their order; a task joining one goes to its end. */
export function columnEnds(side: TaskSide) {
  const ends = new Map<string, number>();
  for (const task of side.tasks)
    ends.set(task.status, Math.max(ends.get(task.status) ?? -1, task.position));
  return (status: string) => {
    const next = (ends.get(status) ?? -1) + 1;
    ends.set(status, next);
    return next;
  };
}

export async function insertTaskCopy(
  tx: Transaction,
  value: {
    source: TaskRow;
    lineage: string;
    targetBranchId: string;
    position: (status: string) => number;
    now: Date;
  }
) {
  const { source } = value;
  const values = taskValues(source);
  const [copy] = await tx
    .insert(tasks)
    .values({
      projectId: source.projectId,
      branchId: value.targetBranchId,
      originId: value.lineage,
      // Keys follow lineage, so a task keeps its key on every branch.
      taskKey: source.taskKey,
      taskNumber: source.taskNumber,
      title: values.title,
      description: values.description,
      priority: values.priority,
      status: values.status,
      position: value.position(values.status),
      version: 1,
      createdByType: source.createdByType,
      createdByUserId: source.createdByUserId,
      createdByAgentId: source.createdByAgentId,
      createdAt: source.createdAt,
      updatedAt: value.now,
      startedAt: source.startedAt,
      completedAt: source.completedAt,
      cancelledAt: source.cancelledAt
    })
    .returning();
  return copy!;
}

/**
 * Writes source values onto a target task. A status change moves the task
 * to the end of its new column, with timestamps as a manual move sets them.
 */
export async function applyTaskValues(
  tx: Transaction,
  value: {
    target: TaskRow;
    values: TaskValues;
    fields: string[];
    position: (status: string) => number;
    now: Date;
  }
) {
  const { target, values, now } = value;
  const set: Partial<typeof tasks.$inferInsert> = {
    version: target.version + 1,
    updatedAt: now
  };
  if (value.fields.includes("title")) set.title = values.title;
  if (value.fields.includes("description"))
    set.description = values.description;
  if (value.fields.includes("priority")) set.priority = values.priority;
  if (value.fields.includes("status") && values.status !== target.status) {
    const status = values.status as TaskRow["status"];
    set.status = status;
    set.position = value.position(status);
    set.startedAt = status === "in_progress" ? (target.startedAt ?? now) : null;
    set.completedAt = status === "done" ? (target.completedAt ?? now) : null;
    set.cancelledAt =
      status === "cancelled" ? (target.cancelledAt ?? now) : null;
  }
  const [updated] = await tx
    .update(tasks)
    .set(set)
    .where(eq(tasks.id, target.id))
    .returning();
  return updated!;
}

/**
 * Copies comments with their authors and timestamps. A thread copied into a
 * task without comments keeps its sequences; otherwise new ones follow the
 * target's last. `imported_at` keeps them out of unread counts and notices.
 */
export async function copyComments(
  tx: Transaction,
  value: {
    comments: CommentRow[];
    targetTask: TaskRow;
    targetLastSequence: number;
    now: Date;
  }
) {
  const keep = value.targetLastSequence === 0;
  let sequence = value.targetLastSequence;
  for (const comment of value.comments) {
    sequence = keep ? comment.sequence : sequence + 1;
    await tx.insert(taskComments).values({
      taskId: value.targetTask.id,
      projectId: value.targetTask.projectId,
      branchId: value.targetTask.branchId,
      originId: lineageOf(comment),
      authorType: comment.authorType,
      authorUserId: comment.authorUserId,
      authorAgentId: comment.authorAgentId,
      authorName: comment.authorName,
      bodyMarkdown: comment.bodyMarkdown,
      sequence,
      mentions: comment.mentions,
      createdAt: comment.createdAt,
      importedAt: value.now
    });
  }
}

export async function insertEdge(
  tx: Transaction,
  value: {
    projectId: string;
    branchId: string;
    taskId: string;
    dependsOnTaskId: string;
  }
) {
  await tx.insert(taskDependencies).values(value);
}
