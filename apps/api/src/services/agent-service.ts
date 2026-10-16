import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  agentCredentials,
  agentLifecycleEvents,
  agentSessions,
  agents,
  chatParticipants,
  chats,
  projects,
  projectEvents,
  taskClaims,
  tasks,
  type Database
} from "@orchestrat/db";
import type {
  AgentPresence,
  CreateAgentRequest,
  IssueAgentCredentialResponse,
  OpenAgentSessionRequest,
  PaginationQuery,
  ProjectEventsResponse,
  AgentLifecycleHookRequest,
  AgentLifecycleHookResponse,
  Project
} from "@orchestrat/protocol";
import { agentCredentialTokenSchema } from "@orchestrat/protocol";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notLike,
  or
} from "drizzle-orm";
import { ApiError } from "./api-error.js";
import {
  defaultBranchId,
  resolveBranch,
  type BranchSelector
} from "./branch-context.js";
import { PermissionService } from "./permission-service.js";
import { recordProjectEvent } from "../realtime/realtime.js";
import { resetsToReadyOnClaimEnd } from "./task-block-hooks.js";

export type AgentPrincipal = {
  agentId: string;
  projectId: string;
  credentialId: string;
  /** Branch headers of the current request. */
  branch?: BranchSelector;
};

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export const agentSessionFreshnessMs = 60_000;

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const isLifecycleConflict = (error: unknown) => {
  const value = error as { code?: string; message?: string };
  return (
    value.code === "23505" ||
    value.message?.includes("agent_sessions") === true ||
    value.message?.includes("agent_lifecycle_events") === true
  );
};
const date = (value: Date | null) => value?.toISOString() ?? null;
const agentJson = (value: typeof agents.$inferSelect) => ({
  id: value.id,
  project_id: value.projectId,
  name: value.name,
  status: value.status,
  created_at: value.createdAt.toISOString(),
  updated_at: value.updatedAt.toISOString(),
  revoked_at: date(value.revokedAt)
});
const credentialJson = (value: typeof agentCredentials.$inferSelect) => ({
  id: value.id,
  agent_id: value.agentId,
  project_id: value.projectId,
  created_at: value.createdAt.toISOString(),
  last_used_at: date(value.lastUsedAt),
  revoked_at: date(value.revokedAt)
});
const sessionJson = (value: typeof agentSessions.$inferSelect) => ({
  id: value.id,
  agent_id: value.agentId,
  project_id: value.projectId,
  branch_id: value.branchId,
  runtime: value.runtime,
  integration: value.integration,
  external_session_id: value.externalSessionId,
  status: value.status,
  started_at: value.startedAt.toISOString(),
  ended_at: date(value.endedAt),
  last_heartbeat_at: value.lastHeartbeatAt.toISOString()
});

export async function insertProjectEvent(
  tx: Transaction,
  value: {
    projectId: string;
    type: string;
    actorAgentId?: string | null;
    actorUserId?: string | null;
    entityId?: string | null;
    payload?: Record<string, unknown>;
    publish?: boolean;
    /** The event's branch; omit for project-wide events (agents, branches). */
    branchId?: string | null;
  }
) {
  const [event] = await tx
    .insert(projectEvents)
    .values({
      projectId: value.projectId,
      branchId: value.branchId ?? null,
      type: value.type,
      actorAgentId: value.actorAgentId ?? null,
      actorUserId: value.actorUserId ?? null,
      entityId: value.entityId ?? null,
      payload: value.payload ?? {}
    })
    .returning();
  if (value.publish !== false) recordProjectEvent(tx, event);
  return event;
}

export class AgentService {
  private readonly permissions: PermissionService;

  constructor(private readonly db: Database) {
    this.permissions = new PermissionService(db);
  }

  async projectForAgent(principal: AgentPrincipal): Promise<Project> {
    const [project] = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, principal.projectId))
      .limit(1);
    if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    return {
      default_branch_id: await defaultBranchId(this.db, project.id),
      id: project.id,
      organization_id: project.organizationId,
      name: project.name,
      slug: project.slug,
      description: project.description,
      status: project.status,
      created_at: project.createdAt.toISOString(),
      updated_at: project.updatedAt.toISOString(),
      archived_at: project.archivedAt?.toISOString() ?? null
    };
  }

  async authenticate(token: string): Promise<AgentPrincipal> {
    const parsed = agentCredentialTokenSchema.safeParse(token);
    if (!parsed.success)
      throw new ApiError(
        401,
        "AGENT_CREDENTIAL_INVALID",
        "Agent credential is invalid."
      );
    const [credential] = await this.db
      .select()
      .from(agentCredentials)
      .where(eq(agentCredentials.tokenHash, hashToken(parsed.data)))
      .limit(1);
    if (!credential)
      throw new ApiError(
        401,
        "AGENT_CREDENTIAL_INVALID",
        "Agent credential is invalid."
      );
    if (credential.revokedAt)
      throw new ApiError(
        401,
        "AGENT_CREDENTIAL_REVOKED",
        "Agent credential has been revoked."
      );
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, credential.agentId),
          eq(agents.projectId, credential.projectId)
        )
      )
      .limit(1);
    if (!agent || agent.status === "revoked")
      throw new ApiError(
        401,
        "AGENT_CREDENTIAL_REVOKED",
        "Agent credential has been revoked."
      );
    await this.db
      .update(agentCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentCredentials.id, credential.id));
    return {
      agentId: agent.id,
      projectId: agent.projectId,
      credentialId: credential.id
    };
  }

  async createAgent(
    userId: string,
    projectId: string,
    input: CreateAgentRequest
  ) {
    await this.permissions.projectEditor(userId, projectId);
    return this.db.transaction(async (tx) => {
      await this.activeProject(tx, projectId);
      const [agent] = await tx
        .insert(agents)
        .values({
          id: randomUUID(),
          projectId,
          name: input.name
        })
        .returning();
      await insertProjectEvent(tx, {
        projectId,
        actorUserId: userId,
        entityId: agent.id,
        type: "agent.created",
        payload: { name: agent.name }
      });
      return agentJson(agent);
    });
  }

  async listAgents(userId: string, projectId: string) {
    await this.permissions.projectAccess(userId, projectId);
    const rows = await this.db
      .select()
      .from(agents)
      .where(eq(agents.projectId, projectId))
      .orderBy(asc(agents.createdAt));
    return { agents: rows.map(agentJson) };
  }

  private async revokeAgentInTransaction(
    tx: Transaction,
    userId: string,
    projectId: string,
    agentId: string
  ) {
    // Security revocation remains allowed on archived projects as shutdown control.
    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.projectId, projectId)))
      .for("update");
    if (!agent) throw new ApiError(404, "AGENT_NOT_FOUND", "Agent not found.");
    if (agent.status === "active") {
      const now = new Date();
      const [revoked] = await tx
        .update(agents)
        .set({ status: "revoked", revokedAt: now, updatedAt: now })
        .where(eq(agents.id, agentId))
        .returning();
      await tx
        .update(agentCredentials)
        .set({ revokedAt: now })
        .where(
          and(
            eq(agentCredentials.projectId, projectId),
            eq(agentCredentials.agentId, agentId),
            isNull(agentCredentials.revokedAt)
          )
        );
      const sessions = await tx
        .select()
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.projectId, projectId),
            eq(agentSessions.agentId, agentId),
            eq(agentSessions.status, "active")
          )
        )
        .for("update");
      for (const session of sessions) {
        await tx
          .update(agentSessions)
          .set({ status: "closed", endedAt: now })
          .where(eq(agentSessions.id, session.id));
        await insertProjectEvent(tx, {
          projectId,
          actorUserId: userId,
          entityId: session.id,
          branchId: session.branchId,
          type: "session.closed",
          payload: { reason: "agent_revoked" }
        });
      }
      const claims = await tx
        .select()
        .from(taskClaims)
        .where(
          and(
            eq(taskClaims.projectId, projectId),
            eq(taskClaims.agentId, agentId),
            eq(taskClaims.status, "active")
          )
        )
        .for("update");
      for (const claim of claims) {
        const [task] = await tx
          .select()
          .from(tasks)
          .where(eq(tasks.id, claim.taskId))
          .for("update");
        await tx
          .update(taskClaims)
          .set({
            status: "revoked",
            releasedAt: now,
            releaseReason: "agent_revoked"
          })
          .where(eq(taskClaims.id, claim.id));
        if (task && resetsToReadyOnClaimEnd(task.status))
          await tx
            .update(tasks)
            .set({
              status: "ready",
              updatedAt: now,
              version: task.version + 1
            })
            .where(eq(tasks.id, task.id));
        await insertProjectEvent(tx, {
          projectId,
          actorUserId: userId,
          entityId: claim.id,
          branchId: claim.branchId,
          type: "claim.revoked",
          payload: { task_id: claim.taskId, reason: "agent_revoked" }
        });
      }
      await insertProjectEvent(tx, {
        projectId,
        actorUserId: userId,
        entityId: agentId,
        type: "agent.revoked"
      });
      return agentJson(revoked);
    }
    return agentJson(agent);
  }

  async revokeAgent(userId: string, projectId: string, agentId: string) {
    await this.permissions.projectEditor(userId, projectId);
    return this.db.transaction((tx) =>
      this.revokeAgentInTransaction(tx, userId, projectId, agentId)
    );
  }

  async revokeAgents(
    userId: string,
    projectId: string,
    agentIds: string[],
    existingTx?: Transaction
  ) {
    await this.permissions.projectEditor(userId, projectId);
    const unique = [...new Set(agentIds)];
    const revoke = async (tx: Transaction) => {
      const rows = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.projectId, projectId), inArray(agents.id, unique)))
        .for("update");
      if (rows.length !== unique.length)
        throw new ApiError(
          404,
          "AGENT_NOT_FOUND",
          "One or more agents are not in the authorized project."
        );
      const revoked = [];
      for (const agentId of unique)
        revoked.push(
          await this.revokeAgentInTransaction(tx, userId, projectId, agentId)
        );
      return revoked;
    };
    return existingTx ? revoke(existingTx) : this.db.transaction(revoke);
  }

  async issueCredential(
    userId: string,
    projectId: string,
    agentId: string
  ): Promise<IssueAgentCredentialResponse> {
    await this.permissions.projectEditor(userId, projectId);
    return this.db.transaction(async (tx) => {
      await this.activeProject(tx, projectId);
      const [agent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.projectId, projectId)))
        .limit(1);
      if (!agent)
        throw new ApiError(404, "AGENT_NOT_FOUND", "Agent not found.");
      if (agent.status === "revoked")
        throw new ApiError(
          409,
          "AGENT_CREDENTIAL_REVOKED",
          "Cannot issue credentials for a revoked agent."
        );
      const token = `orch_agent_${randomBytes(32).toString("base64url")}`;
      const [credential] = await tx
        .insert(agentCredentials)
        .values({
          id: randomUUID(),
          projectId,
          agentId,
          tokenHash: hashToken(token)
        })
        .returning();
      await insertProjectEvent(tx, {
        projectId,
        actorUserId: userId,
        entityId: credential.id,
        type: "credential.issued",
        payload: { agent_id: agentId }
      });
      return { credential: credentialJson(credential), token };
    });
  }

  async listCredentials(userId: string, projectId: string, agentId?: string) {
    await this.permissions.projectAccess(userId, projectId);
    const rows = await this.db
      .select()
      .from(agentCredentials)
      .where(
        and(
          eq(agentCredentials.projectId, projectId),
          ...(agentId ? [eq(agentCredentials.agentId, agentId)] : [])
        )
      )
      .orderBy(desc(agentCredentials.createdAt));
    return { credentials: rows.map(credentialJson) };
  }

  async revokeCredential(
    userId: string,
    projectId: string,
    credentialId: string
  ) {
    // Security revocation remains allowed on archived projects as shutdown control.
    await this.permissions.projectEditor(userId, projectId);
    return this.db.transaction(async (tx) => {
      const [credential] = await tx
        .select()
        .from(agentCredentials)
        .where(
          and(
            eq(agentCredentials.id, credentialId),
            eq(agentCredentials.projectId, projectId)
          )
        )
        .for("update");
      if (!credential)
        throw new ApiError(
          404,
          "AGENT_CREDENTIAL_INVALID",
          "Agent credential not found."
        );
      if (!credential.revokedAt) {
        const now = new Date();
        await tx
          .update(agentCredentials)
          .set({ revokedAt: now })
          .where(eq(agentCredentials.id, credentialId));
        await insertProjectEvent(tx, {
          projectId,
          actorUserId: userId,
          entityId: credentialId,
          type: "credential.revoked",
          payload: { agent_id: credential.agentId }
        });
        return credentialJson({ ...credential, revokedAt: now });
      }
      return credentialJson(credential);
    });
  }

  async openSession(principal: AgentPrincipal, input: OpenAgentSessionRequest) {
    return this.db.transaction(async (tx) => {
      await this.activeProject(tx, principal.projectId);
      await this.agentFor(tx, principal);
      // A new session pins the body's branch, else the header's, else the
      // default. It never inherits another session's pin.
      const branch = await resolveBranch(
        tx,
        principal.projectId,
        { branchId: input.branch_id ?? principal.branch?.branchId ?? null },
        { write: true, agentId: principal.agentId }
      );
      const [session] = await tx
        .insert(agentSessions)
        .values({
          id: randomUUID(),
          projectId: principal.projectId,
          branchId: branch.id,
          agentId: principal.agentId,
          runtime: input.runtime,
          integration: input.integration,
          externalSessionId: input.external_session_id ?? null
        })
        .returning();
      await insertProjectEvent(tx, {
        projectId: principal.projectId,
        actorAgentId: principal.agentId,
        entityId: session.id,
        branchId: session.branchId,
        type: "session.opened",
        payload: { runtime: session.runtime, integration: session.integration }
      });
      return { session: sessionJson(session) };
    });
  }

  async ingestLifecycle(
    principal: AgentPrincipal,
    input: AgentLifecycleHookRequest,
    idempotencyKey: string
  ): Promise<AgentLifecycleHookResponse> {
    const requestHash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    try {
      return await this.db.transaction(async (tx) => {
        await this.activeProject(tx, principal.projectId);
        await this.agentFor(tx, principal);
        const [reservation] = await tx
          .insert(agentLifecycleEvents)
          .values({
            projectId: principal.projectId,
            agentId: principal.agentId,
            idempotencyKey,
            requestHash
          })
          .onConflictDoNothing({
            target: [
              agentLifecycleEvents.projectId,
              agentLifecycleEvents.agentId,
              agentLifecycleEvents.idempotencyKey
            ]
          })
          .returning();
        if (!reservation || reservation.eventId) {
          const previous =
            reservation ??
            (
              await tx
                .select()
                .from(agentLifecycleEvents)
                .where(
                  and(
                    eq(agentLifecycleEvents.projectId, principal.projectId),
                    eq(agentLifecycleEvents.agentId, principal.agentId),
                    eq(agentLifecycleEvents.idempotencyKey, idempotencyKey)
                  )
                )
                .limit(1)
            )[0];
          if (!previous || previous.requestHash !== requestHash)
            throw new ApiError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "The idempotency key was already used with a different request."
            );
          if (!previous.eventId || !previous.sessionId)
            throw new ApiError(
              409,
              "CONFLICT",
              "The idempotent request is still being processed."
            );
          const [session] = await tx
            .select()
            .from(agentSessions)
            .where(eq(agentSessions.id, previous.sessionId));
          if (!session)
            throw new ApiError(
              500,
              "INTERNAL_ERROR",
              "Lifecycle session is missing."
            );
          return { event_id: previous.eventId, session: sessionJson(session) };
        }

        let session: typeof agentSessions.$inferSelect;
        const [existing] = await tx
          .select()
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.id, input.session_id),
              eq(agentSessions.projectId, principal.projectId),
              eq(agentSessions.agentId, principal.agentId)
            )
          )
          .for("update");
        const now = new Date();
        if (input.event === "session.started") {
          if (existing?.status === "closed")
            throw new ApiError(
              409,
              "AGENT_SESSION_CLOSED",
              "Agent session is closed."
            );
          // The strict hook body carries no branch; it rides in the header.
          const branch = await resolveBranch(
            tx,
            principal.projectId,
            { branchId: principal.branch?.branchId ?? null },
            { write: true, agentId: principal.agentId }
          );
          if (existing && existing.branchId !== branch.id)
            throw new ApiError(
              409,
              "AGENT_SESSION_CLOSED",
              "Agent session is pinned to another branch.",
              {
                reason: "branch_mismatch",
                session_branch_id: existing.branchId
              }
            );
          if (existing) {
            const [updated] = await tx
              .update(agentSessions)
              .set({
                runtime: input.runtime,
                integration: input.integration,
                externalSessionId: input.external_session_id ?? null,
                lastHeartbeatAt: now
              })
              .where(eq(agentSessions.id, existing.id))
              .returning();
            session = updated!;
          } else {
            const [created] = await tx
              .insert(agentSessions)
              .values({
                id: input.session_id,
                projectId: principal.projectId,
                branchId: branch.id,
                agentId: principal.agentId,
                runtime: input.runtime,
                integration: input.integration,
                externalSessionId: input.external_session_id ?? null
              })
              .returning();
            session = created!;
          }
        } else if (input.event === "session.ended") {
          if (!existing)
            throw new ApiError(
              404,
              "AGENT_SESSION_NOT_FOUND",
              "Agent session not found."
            );
          session = await this.closeSessionInTransaction(
            tx,
            principal,
            existing,
            now
          );
          // A checkout that switched branches mid-conversation left a sibling
          // session with the same external id on the other branch.
          if (existing.externalSessionId) {
            const siblings = await tx
              .select()
              .from(agentSessions)
              .where(
                and(
                  eq(agentSessions.projectId, principal.projectId),
                  eq(agentSessions.agentId, principal.agentId),
                  eq(
                    agentSessions.externalSessionId,
                    existing.externalSessionId
                  ),
                  eq(agentSessions.status, "active")
                )
              )
              .for("update");
            for (const sibling of siblings)
              await this.closeSessionInTransaction(tx, principal, sibling, now);
          }
        } else {
          if (!existing)
            throw new ApiError(
              404,
              "AGENT_SESSION_NOT_FOUND",
              "Agent session not found."
            );
          const [updated] = await tx
            .update(agentSessions)
            .set({ lastHeartbeatAt: now })
            .where(eq(agentSessions.id, existing.id))
            .returning();
          session = updated!;
        }
        const event = await insertProjectEvent(tx, {
          projectId: principal.projectId,
          actorAgentId: principal.agentId,
          entityId: session.id,
          branchId: session.branchId,
          type: input.event,
          payload: {
            runtime: input.runtime,
            integration: input.integration,
            ...(input.error ? { error: input.error } : {})
          }
        });
        await tx
          .update(agentLifecycleEvents)
          .set({ eventId: event.id, sessionId: session.id })
          .where(eq(agentLifecycleEvents.id, reservation!.id));
        return { event_id: event!.id, session: sessionJson(session) };
      });
    } catch (error) {
      if (!isLifecycleConflict(error)) throw error;
      const [previous] = await this.db
        .select()
        .from(agentLifecycleEvents)
        .where(
          and(
            eq(agentLifecycleEvents.projectId, principal.projectId),
            eq(agentLifecycleEvents.agentId, principal.agentId),
            eq(agentLifecycleEvents.idempotencyKey, idempotencyKey)
          )
        )
        .limit(1);
      if (!previous || previous.requestHash !== requestHash) throw error;
      if (!previous.eventId || !previous.sessionId) throw error;
      const [session] = await this.db
        .select()
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.id, previous.sessionId),
            eq(agentSessions.projectId, principal.projectId),
            eq(agentSessions.agentId, principal.agentId)
          )
        )
        .limit(1);
      if (!session) throw error;
      return { event_id: previous.eventId, session: sessionJson(session) };
    }
  }

  async heartbeat(principal: AgentPrincipal, sessionId: string) {
    return this.db.transaction(async (tx) => {
      const session = await this.sessionFor(tx, principal, sessionId);
      const now = new Date();
      const [updated] = await tx
        .update(agentSessions)
        .set({ lastHeartbeatAt: now })
        .where(eq(agentSessions.id, session.id))
        .returning();
      const activeClaims = await tx
        .select()
        .from(taskClaims)
        .where(
          and(
            eq(taskClaims.projectId, principal.projectId),
            eq(taskClaims.agentId, principal.agentId),
            eq(taskClaims.sessionId, session.id),
            eq(taskClaims.status, "active"),
            gt(taskClaims.leaseExpiresAt, now)
          )
        )
        .for("update");
      const renewed: { id: string }[] = [];
      for (const claim of activeClaims) {
        const leaseDuration = Math.max(
          30_000,
          claim.leaseExpiresAt.getTime() - claim.lastHeartbeatAt.getTime()
        );
        await tx
          .update(taskClaims)
          .set({
            lastHeartbeatAt: now,
            leaseExpiresAt: new Date(now.getTime() + leaseDuration)
          })
          .where(eq(taskClaims.id, claim.id));
        renewed.push({ id: claim.id });
      }
      await insertProjectEvent(tx, {
        projectId: principal.projectId,
        actorAgentId: principal.agentId,
        entityId: session.id,
        branchId: session.branchId,
        type: "session.heartbeat",
        payload: { renewed_claim_ids: renewed.map((row) => row.id) }
      });
      return {
        session: sessionJson(updated),
        renewed_claim_ids: renewed.map((row) => row.id)
      };
    });
  }

  async closeSession(principal: AgentPrincipal, sessionId: string) {
    return this.db.transaction(async (tx) => {
      await this.activeProject(tx, principal.projectId);
      await this.agentFor(tx, principal);
      const session = await this.ownedSession(tx, principal, sessionId);
      if (session.status === "closed") return { session: sessionJson(session) };
      const updated = await this.closeSessionInTransaction(
        tx,
        principal,
        session,
        new Date()
      );
      return { session: sessionJson(updated) };
    });
  }

  /**
   * Closes every active session on a branch that is being archived; their
   * claims are revoked like any session close.
   */
  async closeBranchSessions(
    tx: Transaction,
    projectId: string,
    branchId: string,
    now = new Date()
  ) {
    const sessions = await tx
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.projectId, projectId),
          eq(agentSessions.branchId, branchId),
          eq(agentSessions.status, "active")
        )
      )
      .for("update");
    for (const session of sessions)
      await this.closeSessionInTransaction(
        tx,
        { agentId: session.agentId, projectId, credentialId: "" },
        session,
        now,
        "branch_archived"
      );
    return sessions.length;
  }

  /** `reason` lands on revoked claims and the events. */
  private async closeSessionInTransaction(
    tx: Transaction,
    principal: AgentPrincipal,
    session: typeof agentSessions.$inferSelect,
    now: Date,
    reason: "session_closed" | "branch_archived" = "session_closed"
  ) {
    if (session.status === "closed") return session;
    const claims = await tx
      .select()
      .from(taskClaims)
      .where(
        and(
          eq(taskClaims.projectId, principal.projectId),
          eq(taskClaims.agentId, principal.agentId),
          eq(taskClaims.sessionId, session.id),
          eq(taskClaims.status, "active")
        )
      )
      .for("update");
    for (const claim of claims) {
      const [task] = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, claim.taskId))
        .for("update");
      await tx
        .update(taskClaims)
        .set({
          status: "revoked",
          releasedAt: now,
          releaseReason: reason
        })
        .where(eq(taskClaims.id, claim.id));
      if (task && resetsToReadyOnClaimEnd(task.status))
        await tx
          .update(tasks)
          .set({ status: "ready", updatedAt: now, version: task.version + 1 })
          .where(eq(tasks.id, task.id));
      await insertProjectEvent(tx, {
        projectId: principal.projectId,
        actorAgentId: principal.agentId,
        entityId: claim.id,
        branchId: claim.branchId,
        type: "claim.revoked",
        payload: { task_id: claim.taskId, reason }
      });
    }
    const [updated] = await tx
      .update(agentSessions)
      .set({ status: "closed", endedAt: now })
      .where(eq(agentSessions.id, session.id))
      .returning();
    await insertProjectEvent(tx, {
      projectId: principal.projectId,
      actorAgentId: principal.agentId,
      entityId: session.id,
      branchId: session.branchId,
      type: "session.closed",
      ...(reason === "branch_archived" ? { payload: { reason } } : {})
    });
    return updated!;
  }

  async presence(
    userId: string,
    projectId: string
  ): Promise<{ agents: AgentPresence[] }> {
    await this.permissions.projectAccess(userId, projectId);
    return this.presenceForProject(projectId);
  }

  async presenceForProject(projectId: string) {
    const cutoff = new Date(Date.now() - agentSessionFreshnessMs);
    const rows = await this.db
      .select({ agent: agents, session: agentSessions, claim: taskClaims })
      .from(agents)
      .leftJoin(
        agentSessions,
        and(
          eq(agentSessions.projectId, agents.projectId),
          eq(agentSessions.agentId, agents.id),
          eq(agentSessions.status, "active"),
          gt(agentSessions.lastHeartbeatAt, cutoff)
        )
      )
      .leftJoin(
        taskClaims,
        and(
          eq(taskClaims.projectId, agents.projectId),
          eq(taskClaims.agentId, agents.id),
          eq(taskClaims.sessionId, agentSessions.id),
          eq(taskClaims.status, "active"),
          gt(taskClaims.leaseExpiresAt, new Date())
        )
      )
      .where(and(eq(agents.projectId, projectId), eq(agents.status, "active")));
    const result = new Map<string, AgentPresence>();
    for (const row of rows) {
      const existing = result.get(row.agent.id);
      if (existing && existing.current_task_id) continue;
      result.set(row.agent.id, {
        agent_id: row.agent.id,
        project_id: projectId,
        session_id: row.session?.id ?? null,
        branch_id: row.session?.branchId ?? null,
        status: row.session ? "online" : "offline",
        last_heartbeat_at: row.session
          ? row.session.lastHeartbeatAt.toISOString()
          : null,
        current_task_id: row.claim?.taskId ?? null
      });
    }
    return { agents: [...result.values()] };
  }

  async listEventsHuman(
    userId: string,
    projectId: string,
    query: PaginationQuery,
    selector?: BranchSelector,
    allBranches = false
  ): Promise<ProjectEventsResponse> {
    await this.permissions.projectAccess(userId, projectId);
    // A branch's feed includes project-wide events; realtime catch-up reads
    // every branch so it keeps one monotonic cursor.
    const branchId = allBranches
      ? null
      : (await resolveBranch(this.db, projectId, selector)).id;
    return this.listEvents(
      projectId,
      query,
      { type: "human", id: userId },
      branchId
    );
  }

  async listEventsAgent(principal: AgentPrincipal, query: PaginationQuery) {
    const branch = await resolveBranch(
      this.db,
      principal.projectId,
      principal.branch,
      { agentId: principal.agentId }
    );
    return this.listEvents(
      principal.projectId,
      query,
      { type: "agent", id: principal.agentId },
      branch.id
    );
  }

  private async listEvents(
    projectId: string,
    query: PaginationQuery,
    viewer: { type: "human" | "agent"; id: string },
    branchId: string | null
  ) {
    const after = query.after ? Number(query.after) : 0;
    if (!Number.isSafeInteger(after) || after < 0)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "The event cursor is invalid."
      );
    const rows = await this.db
      .select({ event: projectEvents })
      .from(projectEvents)
      .leftJoin(
        chats,
        and(
          eq(chats.id, projectEvents.entityId),
          eq(chats.projectId, projectEvents.projectId)
        )
      )
      .leftJoin(
        chatParticipants,
        and(
          eq(chatParticipants.chatId, chats.id),
          viewer.type === "human"
            ? eq(chatParticipants.userId, viewer.id)
            : eq(chatParticipants.agentId, viewer.id)
        )
      )
      .where(
        and(
          eq(projectEvents.projectId, projectId),
          gt(projectEvents.id, after),
          branchId
            ? or(
                eq(projectEvents.branchId, branchId),
                isNull(projectEvents.branchId)
              )
            : undefined,
          ne(projectEvents.type, "chat.access_invalidated"),
          or(
            notLike(projectEvents.type, "chat.%"),
            isNotNull(chatParticipants.id),
            viewer.type === "human" ? eq(chats.hasHuman, false) : undefined
          )
        )
      )
      .orderBy(asc(projectEvents.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit).map((row) => row.event);
    return {
      events: page.map((event) => ({
        id: event.id,
        project_id: event.projectId,
        branch_id: event.branchId,
        type: event.type,
        actor_agent_id: event.actorAgentId,
        actor_user_id: event.actorUserId,
        entity_id: event.entityId,
        payload: event.payload,
        occurred_at: event.occurredAt.toISOString()
      })),
      next_cursor: rows.length > query.limit ? String(page.at(-1)!.id) : null
    };
  }

  private async agentFor(tx: Transaction, principal: AgentPrincipal) {
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

  private async activeProject(tx: Transaction, projectId: string) {
    const [project] = await tx
      .select({ status: projects.status })
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

  private async sessionFor(
    tx: Transaction,
    principal: AgentPrincipal,
    sessionId: string
  ) {
    await this.activeProject(tx, principal.projectId);
    await this.agentFor(tx, principal);
    const session = await this.ownedSession(tx, principal, sessionId);
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

  private async ownedSession(
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
    return session;
  }
}
