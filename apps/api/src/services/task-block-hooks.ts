import { taskBlocks, taskClaims, tasks } from "@orchestrat/db";
import type { TaskBlockResolution } from "@orchestrat/protocol";
import { and, eq, isNull } from "drizzle-orm";
import { insertProjectEvent, type Transaction } from "./agent-service.js";
import type { Actor } from "./attention-hooks.js";

// Transaction-scoped block hooks. Callers hold the project row lock, so block
// resolution and the claim or move that triggers it commit together and are
// serialized with every other task write in the project.
export type TaskStatus = (typeof tasks.$inferSelect)["status"];
export type TaskBlockRow = typeof taskBlocks.$inferSelect;

// Involuntary claim ends (lease expiry, session close, revoke) send claimed
// and in-progress work back to ready. Blocked tasks keep their open block.
export const resetsToReadyOnClaimEnd = (
  status: TaskStatus | null | undefined
): boolean => status === "claimed" || status === "in_progress";

export async function activeClaim(tx: Transaction, taskId: string) {
  const [claim] = await tx
    .select()
    .from(taskClaims)
    .where(and(eq(taskClaims.taskId, taskId), eq(taskClaims.status, "active")))
    .limit(1);
  return claim ?? null;
}

export async function hasActiveClaim(tx: Transaction, taskId: string) {
  return (await activeClaim(tx, taskId)) !== null;
}

export async function openBlock(tx: Transaction, taskId: string) {
  const [block] = await tx
    .select()
    .from(taskBlocks)
    .where(and(eq(taskBlocks.taskId, taskId), isNull(taskBlocks.resolvedAt)))
    .for("update");
  return block ?? null;
}

const actorColumns = (actor?: Actor) => ({
  resolvedByUserId: actor?.type === "human" ? actor.id : null,
  resolvedByAgentId: actor?.type === "agent" ? actor.id : null
});
const eventActor = (actor?: Actor) => ({
  actorUserId: actor?.type === "human" ? actor.id : null,
  actorAgentId: actor?.type === "agent" ? actor.id : null
});
const isCreator = (block: TaskBlockRow, actor?: Actor) =>
  actor !== undefined &&
  (actor.type === "human"
    ? block.createdByUserId === actor.id
    : block.createdByAgentId === actor.id);

// Marks a block resolved and records task.block_resolved without touching the
// task row. Returns null when the block was already resolved, so concurrent
// triggers resolve it exactly once. A creator resolving its own block has
// seen the outcome, so no blocker_resolved attention item is left behind.
export async function closeBlock(
  tx: Transaction,
  block: TaskBlockRow,
  input: {
    resolution: TaskBlockResolution;
    resolvedBy?: Actor;
    toStatus: TaskStatus;
  }
) {
  const now = new Date();
  const [closed] = await tx
    .update(taskBlocks)
    .set({
      resolvedAt: now,
      resolution: input.resolution,
      ...actorColumns(input.resolvedBy),
      resolutionSeenAt: isCreator(block, input.resolvedBy) ? now : null
    })
    .where(and(eq(taskBlocks.id, block.id), isNull(taskBlocks.resolvedAt)))
    .returning();
  if (!closed) return null;
  const [owner] = await tx
    .select({ branchId: tasks.branchId })
    .from(tasks)
    .where(eq(tasks.id, block.taskId));
  await insertProjectEvent(tx, {
    projectId: block.projectId,
    ...eventActor(input.resolvedBy),
    entityId: block.taskId,
    branchId: owner?.branchId ?? null,
    type: "task.block_resolved",
    payload: {
      block_id: block.id,
      resolution: input.resolution,
      to_status: input.toStatus
    }
  });
  return closed;
}

// Resolves a block and, when the task is still blocked, returns it to work:
// in_progress while a claim is active, otherwise ready. A task a human or
// the claimant already moved elsewhere (done, cancelled, review, backlog…)
// keeps its status.
export async function resolveBlock(
  tx: Transaction,
  block: TaskBlockRow,
  input: { resolution: TaskBlockResolution; resolvedBy?: Actor }
) {
  const [task] = await tx
    .select()
    .from(tasks)
    .where(eq(tasks.id, block.taskId))
    .for("update");
  if (!task) return null;
  const claim =
    task.status === "blocked" ? await activeClaim(tx, task.id) : null;
  const toStatus: TaskStatus =
    task.status === "blocked" ? (claim ? "in_progress" : "ready") : task.status;
  const closed = await closeBlock(tx, block, { ...input, toStatus });
  if (!closed || toStatus === task.status) return closed;
  const now = new Date();
  await tx
    .update(tasks)
    .set({
      status: toStatus,
      startedAt:
        toStatus === "in_progress" ? (task.startedAt ?? now) : task.startedAt,
      updatedAt: now,
      version: task.version + 1
    })
    .where(eq(tasks.id, task.id));
  await insertProjectEvent(tx, {
    projectId: task.projectId,
    ...eventActor(input.resolvedBy),
    entityId: task.id,
    branchId: task.branchId,
    type: "task.status_changed",
    payload: {
      from_status: task.status,
      to_status: toStatus,
      claim_id: claim?.id ?? null
    }
  });
  return closed;
}

async function resolveDependentBlocks(
  tx: Transaction,
  input: {
    projectId: string;
    taskId: string;
    resolution: "blocking_task_done" | "blocking_task_cancelled";
    resolvedBy: Actor;
  }
) {
  const dependents = await tx
    .select()
    .from(taskBlocks)
    .where(
      and(
        eq(taskBlocks.projectId, input.projectId),
        eq(taskBlocks.blockingTaskId, input.taskId),
        isNull(taskBlocks.resolvedAt)
      )
    )
    .for("update");
  for (const block of dependents)
    await resolveBlock(tx, block, {
      resolution: input.resolution,
      resolvedBy: input.resolvedBy
    });
}

// Called by TaskClaimService.mutate after the task update. Completion unblocks
// tasks waiting on this one; the task's own block (if the claimant completes
// or releases while blocked) is closed as well.
export async function onClaimEnded(
  tx: Transaction,
  input: {
    projectId: string;
    taskId: string;
    agentId: string;
    outcome: "released" | "completed";
  }
) {
  const agent: Actor = { type: "agent", id: input.agentId };
  const own = await openBlock(tx, input.taskId);
  if (own)
    await resolveBlock(tx, own, {
      resolution: input.outcome === "released" ? "released" : "status_changed",
      resolvedBy: agent
    });
  if (input.outcome === "completed")
    await resolveDependentBlocks(tx, {
      projectId: input.projectId,
      taskId: input.taskId,
      resolution: "blocking_task_done",
      resolvedBy: agent
    });
}

// Called by TaskService after task.moved. Humans move from the board; agents
// move unclaimed tasks with update_task.
export async function onTaskMoved(
  tx: Transaction,
  input: {
    projectId: string;
    taskId: string;
    fromStatus: TaskStatus;
    toStatus: TaskStatus;
    actor: Actor;
  }
) {
  if (input.fromStatus === "blocked" && input.toStatus !== "blocked") {
    const own = await openBlock(tx, input.taskId);
    if (own)
      await resolveBlock(tx, own, {
        resolution:
          input.actor.type === "human" ? "moved_by_human" : "status_changed",
        resolvedBy: input.actor
      });
  }
  if (input.toStatus === "done" || input.toStatus === "cancelled")
    await resolveDependentBlocks(tx, {
      projectId: input.projectId,
      taskId: input.taskId,
      resolution:
        input.toStatus === "done"
          ? "blocking_task_done"
          : "blocking_task_cancelled",
      resolvedBy: input.actor
    });
}

// The blocked_on participant answered on the blocked task (a comment, or a
// handoff to the block's creator referencing the task). Pass `to` for
// handoffs so only a handoff addressed to the creator resolves the block.
export async function resolveBlocksOnParticipantResponse(
  tx: Transaction,
  input: {
    projectId: string;
    taskId: string;
    participant: Actor;
    to?: Actor;
  }
) {
  const block = await openBlock(tx, input.taskId);
  if (!block || block.projectId !== input.projectId) return null;
  const blockedOn =
    input.participant.type === "human"
      ? block.blockedOnUserId
      : block.blockedOnAgentId;
  if (blockedOn !== input.participant.id) return null;
  if (input.to && !isCreator(block, input.to)) return null;
  return resolveBlock(tx, block, {
    resolution: "participant_responded",
    resolvedBy: input.participant
  });
}
