import {
  projects,
  taskBlocks,
  taskClaims,
  tasks,
  type Database
} from "@orchestrat/db";
import type {
  SetTaskStatusRequest,
  SetTaskStatusResponse,
  TaskBlock
} from "@orchestrat/protocol";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  insertProjectEvent,
  type AgentPrincipal,
  type Transaction
} from "./agent-service.js";
import { ApiError } from "./api-error.js";
import { assertCommentsAcknowledged } from "./attention-guard.js";
import { resolveCommentMentions, type Actor } from "./attention-hooks.js";
import { taskBlocksJson } from "./attention-service.js";
import { PermissionService } from "./permission-service.js";
import {
  closeBlock,
  openBlock,
  resolveBlock,
  type TaskBlockRow,
  type TaskStatus
} from "./task-block-hooks.js";
import type { TaskClaimService } from "./task-claim-service.js";

type TaskRow = typeof tasks.$inferSelect;
type ClaimRow = typeof taskClaims.$inferSelect;

// Statuses a claimant can move from. A task with an active claim is never in
// review, done or cancelled.
const claimantStatuses = new Set<TaskStatus>([
  "claimed",
  "in_progress",
  "blocked"
]);

const invalidTransition = (from: TaskStatus, to: TaskStatus) =>
  new ApiError(
    409,
    "INVALID_STATUS_TRANSITION",
    `A ${from} task cannot move to ${to}.`,
    { from_status: from, to_status: to }
  );

export class TaskStatusService {
  private readonly permissions: PermissionService;

  constructor(
    protected readonly db: Database,
    protected readonly claims: TaskClaimService
  ) {
    this.permissions = new PermissionService(db);
  }

  async setStatus(
    principal: AgentPrincipal,
    sessionId: string,
    input: SetTaskStatusRequest
  ): Promise<SetTaskStatusResponse> {
    return this.claims.withActiveClaim(
      principal,
      sessionId,
      input.claim_token,
      async (tx, { claim, task, now }) => {
        const from = task.status;
        const to = input.status;
        if (!claimantStatuses.has(from)) throw invalidTransition(from, to);
        const agent: Actor = { type: "agent", id: principal.agentId };
        // Setting a status counts as having seen this task's resolved blocks.
        await tx
          .update(taskBlocks)
          .set({ resolutionSeenAt: now })
          .where(
            and(
              eq(taskBlocks.taskId, task.id),
              eq(taskBlocks.createdByAgentId, principal.agentId),
              isNotNull(taskBlocks.resolvedAt),
              isNull(taskBlocks.resolutionSeenAt)
            )
          );
        if (to === "in_progress" && from === "in_progress")
          return this.response(tx, task, claim, null);
        const current = await openBlock(tx, task.id);
        let opened: TaskBlockRow | null = null;
        let claimAfter = claim;
        if (to === "blocked") {
          // Blocked replaces any open block; the claim stays active.
          const target = await this.validateBlock(tx, principal, task, input);
          if (current)
            await closeBlock(tx, current, {
              resolution: "status_changed",
              resolvedBy: agent,
              toStatus: "blocked"
            });
          [opened] = await tx
            .insert(taskBlocks)
            .values({
              projectId: principal.projectId,
              taskId: task.id,
              createdByType: "agent",
              createdByAgentId: principal.agentId,
              claimId: claim.id,
              reason: input.reason!,
              blockingTaskId: target.blockingTaskId,
              blockedOnUserId:
                target.blockedOn?.type === "human" ? target.blockedOn.id : null,
              blockedOnAgentId:
                target.blockedOn?.type === "agent" ? target.blockedOn.id : null,
              createdAt: now
            })
            .returning();
        } else {
          if (to === "review") {
            // Review ends the claim, so the completion guard applies.
            await assertCommentsAcknowledged(tx, {
              projectId: principal.projectId,
              taskId: task.id,
              agentId: principal.agentId,
              acknowledgedThrough: input.acknowledged_through
            });
            [claimAfter] = await tx
              .update(taskClaims)
              .set({
                status: "released",
                releasedAt: now,
                releaseReason: "submitted_for_review"
              })
              .where(eq(taskClaims.id, claim.id))
              .returning();
            await insertProjectEvent(tx, {
              projectId: principal.projectId,
              actorAgentId: principal.agentId,
              entityId: claim.id,
              branchId: claim.branchId,
              type: "claim.released",
              payload: {
                task_id: task.id,
                session_id: claim.sessionId,
                reason: "submitted_for_review"
              }
            });
          }
          if (current)
            await closeBlock(tx, current, {
              resolution: "status_changed",
              resolvedBy: agent,
              toStatus: to
            });
        }
        const [updated] = await tx
          .update(tasks)
          .set({
            status: to,
            startedAt:
              to === "in_progress" ? (task.startedAt ?? now) : task.startedAt,
            updatedAt: now,
            version: task.version + 1
          })
          .where(eq(tasks.id, task.id))
          .returning();
        await insertProjectEvent(tx, {
          projectId: principal.projectId,
          actorAgentId: principal.agentId,
          entityId: task.id,
          branchId: task.branchId,
          type: "task.status_changed",
          payload: {
            from_status: from,
            to_status: to,
            claim_id: claim.id,
            ...(opened
              ? {
                  block: {
                    id: opened.id,
                    blocked_on: opened.blockedOnUserId
                      ? { type: "human", id: opened.blockedOnUserId }
                      : opened.blockedOnAgentId
                        ? { type: "agent", id: opened.blockedOnAgentId }
                        : null,
                    blocking_task_id: opened.blockingTaskId
                  }
                }
              : {})
          }
        });
        return this.response(tx, updated!, claimAfter!, opened);
      }
    );
  }

  async resolveBlockHuman(userId: string, taskId: string): Promise<TaskBlock> {
    const [task] = await this.db
      .select({ id: tasks.id, projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!task) throw new ApiError(404, "NOT_FOUND", "Task not found.");
    await this.permissions.projectAccess(userId, task.projectId);
    return this.db.transaction(async (tx) => {
      const [project] = await tx
        .select({ status: projects.status })
        .from(projects)
        .where(eq(projects.id, task.projectId))
        .for("update");
      if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
      if (project.status === "archived")
        throw new ApiError(
          409,
          "PROJECT_ARCHIVED",
          "Archived projects are read-only."
        );
      const block = await openBlock(tx, task.id);
      const resolved =
        block &&
        (await resolveBlock(tx, block, {
          resolution: "resolved_by_human",
          resolvedBy: { type: "human", id: userId }
        }));
      if (!resolved)
        throw new ApiError(404, "NOT_FOUND", "The task has no open blocker.");
      return (await taskBlocksJson(tx, [resolved]))[0]!;
    });
  }

  // Blocking-task and blocked_on checks: same project, not the task itself, no
  // direct two-task cycle, and a message candidate other than the agent. Longer
  // cycles are allowed; resolving any blocker breaks them.
  private async validateBlock(
    tx: Transaction,
    principal: AgentPrincipal,
    task: TaskRow,
    input: SetTaskStatusRequest
  ) {
    if (!input.reason?.trim())
      throw new ApiError(400, "VALIDATION_ERROR", "Blocked needs a reason.");
    const blockingTaskId = input.blocking_task_id ?? null;
    if (blockingTaskId === task.id)
      throw new ApiError(409, "BLOCKER_CYCLE", "A task cannot block itself.");
    if (blockingTaskId) {
      const [blocking] = await tx
        .select({
          id: tasks.id,
          key: tasks.taskKey,
          status: tasks.status,
          branchId: tasks.branchId
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.id, blockingTaskId),
            eq(tasks.projectId, principal.projectId)
          )
        )
        .limit(1);
      if (!blocking)
        throw new ApiError(404, "NOT_FOUND", "Blocking task not found.");
      // Blocks stay within a branch, like dependencies.
      if (blocking.branchId !== task.branchId)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "A task can only be blocked by a task on its branch.",
          { reason: "cross_branch", blocking_task_id: blocking.id }
        );
      // A finished blocker would never resolve the block.
      if (blocking.status === "done" || blocking.status === "cancelled")
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          `The blocking task is already ${blocking.status}.`,
          { blocking_task_id: blocking.id, status: blocking.status }
        );
      const reverse = await openBlock(tx, blocking.id);
      if (reverse?.blockingTaskId === task.id)
        throw new ApiError(
          409,
          "BLOCKER_CYCLE",
          `${blocking.key} is already blocked by this task.`,
          { blocking_task_id: blocking.id, block_id: reverse.id }
        );
    }
    const blockedOn = input.blocked_on ?? null;
    if (blockedOn) {
      if (blockedOn.type === "agent" && blockedOn.id === principal.agentId)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "An agent cannot be blocked on itself."
        );
      try {
        await resolveCommentMentions(tx, principal.projectId, [blockedOn]);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "blocked_on must be a member or an active agent of this project."
        );
      }
    }
    return { blockingTaskId, blockedOn };
  }

  private async response(
    tx: Transaction,
    task: TaskRow,
    claim: ClaimRow,
    block: TaskBlockRow | null
  ): Promise<SetTaskStatusResponse> {
    return {
      task: {
        id: task.id,
        key: task.taskKey,
        status: task.status,
        version: task.version
      },
      claim: {
        id: claim.id,
        status: claim.status,
        lease_expires_at: claim.leaseExpiresAt.toISOString()
      },
      block: block ? ((await taskBlocksJson(tx, [block]))[0] ?? null) : null
    };
  }
}
