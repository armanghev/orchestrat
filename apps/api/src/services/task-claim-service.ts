import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  agentSessions,
  agents,
  projects,
  taskClaims,
  taskDependencies,
  tasks,
  type Database
} from "@orchestrat/db";
import type {
  ClaimTaskRequest,
  CompleteClaimRequest,
  ReleaseClaimRequest
} from "@orchestrat/protocol";
import { and, eq, lte, sql } from "drizzle-orm";
import { ApiError } from "./api-error.js";
import { findProjectBranch } from "./branch-context.js";
import { assertCommentsAcknowledged } from "./attention-guard.js";
import { onTaskClaimed } from "./attention-hooks.js";
import {
  agentSessionFreshnessMs,
  type AgentPrincipal,
  insertProjectEvent
} from "./agent-service.js";
import { onClaimEnded, resetsToReadyOnClaimEnd } from "./task-block-hooks.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const claimJson = (value: typeof taskClaims.$inferSelect) => ({
  id: value.id,
  project_id: value.projectId,
  branch_id: value.branchId,
  task_id: value.taskId,
  agent_id: value.agentId,
  session_id: value.sessionId,
  status: value.status,
  claimed_at: value.claimedAt.toISOString(),
  lease_expires_at: value.leaseExpiresAt.toISOString(),
  released_at: value.releasedAt?.toISOString() ?? null,
  completed_at: value.completedAt?.toISOString() ?? null
});

const isActiveClaimConflict = (error: unknown) => {
  const value = error as { code?: string; message?: string };
  return (
    value.code === "23505" ||
    (value.message?.includes('"task_claims"') === true &&
      value.message.includes("task_id"))
  );
};

export class TaskClaimService {
  constructor(private readonly db: Database) {}

  async claim(
    principal: AgentPrincipal,
    taskId: string,
    input: ClaimTaskRequest
  ) {
    try {
      return await this.db.transaction(async (tx) => {
        const project = await this.lockProject(tx, principal.projectId);
        await this.activeAgent(tx, principal);
        const session = await this.activeSession(
          tx,
          principal,
          input.session_id
        );
        // The session pins the branch; a header naming another one is refused.
        if (
          principal.branch?.branchId &&
          principal.branch.branchId !== session.branchId
        )
          throw new ApiError(
            409,
            "BRANCH_MISMATCH",
            "The requested branch differs from the session's pinned branch.",
            {
              session_branch_id: session.branchId,
              requested_branch_id: principal.branch.branchId
            }
          );
        let [task] = await tx
          .select()
          .from(tasks)
          .where(
            and(eq(tasks.id, taskId), eq(tasks.projectId, principal.projectId))
          )
          .for("update");
        if (!task) throw new ApiError(404, "NOT_FOUND", "Task not found.");
        await this.expireClaims(tx, principal.projectId, taskId);
        [task] = await tx
          .select()
          .from(tasks)
          .where(
            and(eq(tasks.id, taskId), eq(tasks.projectId, principal.projectId))
          )
          .for("update");
        // Claims belong to the session's branch (spec §6.2). Existing codes
        // with a reason keep old clients parsing the error.
        if (task.branchId !== session.branchId)
          throw new ApiError(
            409,
            "TASK_NOT_CLAIMABLE",
            "The task is on a different branch than the session.",
            {
              reason: "branch_mismatch",
              task_branch_id: task.branchId,
              session_branch_id: session.branchId
            }
          );
        const branch = await findProjectBranch(
          tx,
          principal.projectId,
          task.branchId
        );
        if (branch?.archivedAt)
          throw new ApiError(
            409,
            "TASK_NOT_CLAIMABLE",
            "Tasks on an archived branch cannot be claimed.",
            { reason: "branch_archived", branch_id: task.branchId }
          );
        const [activeClaim] = await tx
          .select()
          .from(taskClaims)
          .where(
            and(eq(taskClaims.taskId, taskId), eq(taskClaims.status, "active"))
          )
          .limit(1);
        if (activeClaim) throw this.alreadyClaimed(activeClaim);
        if (task.status !== "ready")
          throw new ApiError(
            409,
            "TASK_NOT_CLAIMABLE",
            "Only ready tasks can be claimed."
          );
        const [blocker] = await tx
          .select({ id: taskDependencies.dependsOnTaskId })
          .from(taskDependencies)
          .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
          .where(
            and(
              eq(taskDependencies.projectId, principal.projectId),
              eq(taskDependencies.taskId, taskId),
              sql`${tasks.status} <> 'done'`
            )
          )
          .limit(1);
        if (blocker)
          throw new ApiError(
            409,
            "TASK_NOT_CLAIMABLE",
            "Task dependencies are unresolved.",
            { depends_on_task_id: blocker.id }
          );
        const now = new Date();
        const token = `claim_${randomBytes(32).toString("base64url")}`;
        const [claim] = await tx
          .insert(taskClaims)
          .values({
            id: randomUUID(),
            projectId: principal.projectId,
            branchId: task.branchId,
            taskId,
            agentId: principal.agentId,
            sessionId: input.session_id,
            tokenHash: hash(token),
            claimedAt: now,
            lastHeartbeatAt: now,
            leaseExpiresAt: new Date(now.getTime() + input.lease_seconds * 1000)
          })
          .returning();
        await tx
          .update(tasks)
          .set({ status: "claimed", updatedAt: now, version: task.version + 1 })
          .where(eq(tasks.id, task.id));
        await insertProjectEvent(tx, {
          projectId: project.id,
          actorAgentId: principal.agentId,
          entityId: claim.id,
          branchId: claim.branchId,
          type: "claim.created",
          payload: {
            task_id: task.id,
            session_id: input.session_id,
            lease_expires_at: claim.leaseExpiresAt.toISOString()
          }
        });
        await onTaskClaimed(tx, {
          projectId: project.id,
          taskId: task.id,
          agentId: principal.agentId
        });
        return { claim: claimJson(claim), claim_token: token };
      });
    } catch (error) {
      if (!isActiveClaimConflict(error)) throw error;
      const [activeClaim] = await this.db
        .select()
        .from(taskClaims)
        .where(
          and(
            eq(taskClaims.projectId, principal.projectId),
            eq(taskClaims.taskId, taskId),
            eq(taskClaims.status, "active")
          )
        )
        .limit(1);
      if (activeClaim) throw this.alreadyClaimed(activeClaim);
      throw error;
    }
  }

  async release(
    principal: AgentPrincipal,
    sessionId: string,
    input: ReleaseClaimRequest
  ) {
    return this.mutate(
      principal,
      sessionId,
      input.claim_token,
      "released",
      input.acknowledged_through
    );
  }

  async complete(
    principal: AgentPrincipal,
    sessionId: string,
    input: CompleteClaimRequest
  ) {
    return this.mutate(
      principal,
      sessionId,
      input.claim_token,
      "completed",
      input.acknowledged_through
    );
  }

  async reconcileExpired(projectId: string, taskId?: string) {
    return this.db.transaction((tx) =>
      this.expireClaims(tx, projectId, taskId)
    );
  }

  private async mutate(
    principal: AgentPrincipal,
    sessionId: string,
    token: string,
    status: "released" | "completed",
    acknowledgedThrough?: number
  ) {
    const result = await this.db.transaction(async (tx) => {
      const owned = await this.ownedActiveClaim(
        tx,
        principal,
        sessionId,
        token
      );
      if (!owned) return { expired: true as const };
      const { claim, now } = owned;
      const [task] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, claim.taskId))
        .for("update");
      if (!task) throw new ApiError(404, "NOT_FOUND", "Task not found.");
      await assertCommentsAcknowledged(tx, {
        projectId: claim.projectId,
        taskId: task.id,
        agentId: principal.agentId,
        acknowledgedThrough
      });
      const [updated] = await tx
        .update(taskClaims)
        .set({
          status,
          releasedAt: status === "released" ? now : null,
          releaseReason: status === "released" ? "agent_release" : null,
          completedAt: status === "completed" ? now : null
        })
        .where(eq(taskClaims.id, claim.id))
        .returning();
      await tx
        .update(tasks)
        .set({
          status: status === "completed" ? "done" : "ready",
          completedAt: status === "completed" ? now : null,
          updatedAt: now,
          version: task.version + 1
        })
        .where(eq(tasks.id, task.id));
      await insertProjectEvent(tx, {
        projectId: claim.projectId,
        actorAgentId: principal.agentId,
        entityId: claim.id,
        branchId: claim.branchId,
        type: `claim.${status}`,
        payload: {
          task_id: claim.taskId,
          session_id: claim.sessionId,
          ...(status === "released" ? { reason: "agent_release" } : {})
        }
      });
      await onClaimEnded(tx, {
        projectId: claim.projectId,
        taskId: task.id,
        agentId: principal.agentId,
        outcome: status
      });
      return { claim: claimJson(updated) };
    });
    if ("expired" in result)
      throw new ApiError(409, "CLAIM_NOT_FOUND", "Claim lease has expired.");
    return result;
  }

  private async expireClaims(
    tx: Transaction,
    projectId: string,
    taskId?: string
  ) {
    const [project] = await tx
      .select({ status: projects.status })
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update");
    if (!project || project.status === "archived") return 0;
    const now = new Date();
    const rows = await tx
      .select()
      .from(taskClaims)
      .where(
        and(
          eq(taskClaims.projectId, projectId),
          eq(taskClaims.status, "active"),
          lte(taskClaims.leaseExpiresAt, now),
          ...(taskId ? [eq(taskClaims.taskId, taskId)] : [])
        )
      )
      .for("update");
    for (const claim of rows) await this.expireClaim(tx, claim, now);
    return rows.length;
  }

  private async expireClaim(
    tx: Transaction,
    claim: typeof taskClaims.$inferSelect,
    now: Date
  ) {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, claim.taskId))
      .for("update");
    const [updated] = await tx
      .update(taskClaims)
      .set({ status: "expired", releasedAt: now })
      .where(and(eq(taskClaims.id, claim.id), eq(taskClaims.status, "active")))
      .returning();
    if (!updated) return;
    if (task && resetsToReadyOnClaimEnd(task.status))
      await tx
        .update(tasks)
        .set({ status: "ready", updatedAt: now, version: task.version + 1 })
        .where(eq(tasks.id, task.id));
    await insertProjectEvent(tx, {
      projectId: claim.projectId,
      entityId: claim.id,
      branchId: claim.branchId,
      type: "claim.expired",
      payload: {
        task_id: claim.taskId,
        session_id: claim.sessionId,
        agent_id: claim.agentId
      }
    });
  }

  private async activeAgent(tx: Transaction, principal: AgentPrincipal) {
    const [agent] = await tx
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, principal.agentId),
          eq(agents.projectId, principal.projectId),
          eq(agents.status, "active")
        )
      )
      .for("update");
    if (!agent)
      throw new ApiError(
        401,
        "AGENT_CREDENTIAL_REVOKED",
        "Agent credential has been revoked."
      );
    return agent;
  }

  private async activeSession(
    tx: Transaction,
    principal: AgentPrincipal,
    sessionId: string
  ) {
    const [session] = await tx
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.id, sessionId),
          eq(agentSessions.projectId, principal.projectId),
          eq(agentSessions.agentId, principal.agentId)
        )
      )
      .for("update");
    if (!session)
      throw new ApiError(
        404,
        "AGENT_SESSION_NOT_FOUND",
        "Agent session not found."
      );
    if (session.status === "closed")
      throw new ApiError(
        409,
        "AGENT_SESSION_CLOSED",
        "Agent session is closed."
      );
    if (
      session.lastHeartbeatAt.getTime() <=
      Date.now() - agentSessionFreshnessMs
    )
      throw new ApiError(
        409,
        "AGENT_SESSION_STALE",
        "Agent session heartbeat is stale."
      );
    return session;
  }

  private async lockProject(tx: Transaction, projectId: string) {
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update");
    if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    if (project.status === "archived")
      throw new ApiError(
        409,
        "PROJECT_ARCHIVED",
        "Archived projects are read-only."
      );
    return project;
  }

  private alreadyClaimed(claim: typeof taskClaims.$inferSelect): ApiError {
    return new ApiError(
      409,
      "TASK_ALREADY_CLAIMED",
      "Task is already claimed.",
      {
        claim_id: claim.id,
        task_id: claim.taskId,
        agent_id: claim.agentId,
        session_id: claim.sessionId,
        lease_expires_at: claim.leaseExpiresAt.toISOString()
      }
    );
  }

  // Runs fn inside one transaction holding the caller's active claim, with the
  // same project, agent, session and ownership checks as release/complete.
  // An expired lease is expired (and committed) before CLAIM_NOT_FOUND.
  async withActiveClaim<T>(
    principal: AgentPrincipal,
    sessionId: string,
    token: string,
    fn: (
      tx: Transaction,
      context: {
        claim: typeof taskClaims.$inferSelect;
        task: typeof tasks.$inferSelect;
        now: Date;
      }
    ) => Promise<T>
  ): Promise<T> {
    const result = await this.db.transaction(async (tx) => {
      const owned = await this.ownedActiveClaim(
        tx,
        principal,
        sessionId,
        token
      );
      if (!owned) return { expired: true as const };
      const [task] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, owned.claim.taskId))
        .for("update");
      if (!task) throw new ApiError(404, "NOT_FOUND", "Task not found.");
      return {
        expired: false as const,
        value: await fn(tx, { claim: owned.claim, task, now: owned.now })
      };
    });
    if (result.expired)
      throw new ApiError(409, "CLAIM_NOT_FOUND", "Claim lease has expired.");
    return result.value;
  }

  // Locks the project, agent, session and claim in that order. Returns null
  // after expiring a lapsed lease so the caller can commit that first.
  private async ownedActiveClaim(
    tx: Transaction,
    principal: AgentPrincipal,
    sessionId: string,
    token: string
  ) {
    await this.lockProject(tx, principal.projectId);
    await this.activeAgent(tx, principal);
    await this.activeSession(tx, principal, sessionId);
    const [claim] = await tx
      .select()
      .from(taskClaims)
      .where(eq(taskClaims.tokenHash, hash(token)))
      .for("update");
    if (!claim) throw new ApiError(404, "CLAIM_NOT_FOUND", "Claim not found.");
    if (
      claim.projectId !== principal.projectId ||
      claim.agentId !== principal.agentId ||
      claim.sessionId !== sessionId
    )
      throw new ApiError(
        403,
        "CLAIM_NOT_OWNER",
        "The claim belongs to another agent."
      );
    if (claim.status !== "active")
      throw new ApiError(409, "CLAIM_NOT_FOUND", "Claim is no longer active.");
    const now = new Date();
    if (claim.leaseExpiresAt <= now) {
      await this.expireClaim(tx, claim, now);
      return null;
    }
    return { claim, now };
  }
}
