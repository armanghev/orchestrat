import { createHash, randomUUID } from "node:crypto";
import {
  agentCredentials,
  agents,
  apiIdempotencyKeys,
  chatMessages,
  chatParticipants,
  chats,
  documents,
  organizationMembers,
  projectMembers,
  projects,
  users,
  type Database
} from "@orchestrat/db";
import {
  idempotencyKeySchema,
  type ChatMessagesQuery,
  type CreateChatRequest,
  type ManageChatMembersRequest,
  type ParticipantRef,
  type SendMessageRequest
} from "@orchestrat/protocol";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql
} from "drizzle-orm";
import {
  recordRealtimeNotice,
  type RealtimeAudience
} from "../realtime/realtime.js";
import {
  insertProjectEvent,
  type AgentPrincipal,
  type Transaction
} from "./agent-service.js";
import { ApiError } from "./api-error.js";

type Actor =
  | { type: "human"; id: string }
  | { type: "agent"; id: string; credentialId?: string };
type Candidate = ParticipantRef & { name: string; avatar_url: string | null };
type ChatRow = typeof chats.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;

const actorValues = (actor: Actor) => ({
  userId: actor.type === "human" ? actor.id : null,
  agentId: actor.type === "agent" ? actor.id : null
});
const actorClause = (actor: Actor) =>
  actor.type === "human"
    ? and(
        eq(apiIdempotencyKeys.userId, actor.id),
        isNull(apiIdempotencyKeys.agentId)
      )!
    : and(
        eq(apiIdempotencyKeys.agentId, actor.id),
        isNull(apiIdempotencyKeys.userId)
      )!;
const participantClause = (actor: Actor) =>
  actor.type === "human"
    ? eq(chatParticipants.userId, actor.id)
    : eq(chatParticipants.agentId, actor.id);
const keyFor = (value: ParticipantRef) => `${value.type}:${value.id}`;
const stableHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const eventActor = (actor: Actor) => ({
  actorUserId: actor.type === "human" ? actor.id : null,
  actorAgentId: actor.type === "agent" ? actor.id : null
});

export class ChatService {
  constructor(private readonly db: Database) {}

  private async lockActiveProject(tx: Transaction, projectId: string) {
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

  private async humanProject(
    userId: string,
    projectId: string,
    executor: Database = this.db
  ) {
    const [membership] = await executor
      .select({ membership: projectMembers })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, projects.organizationId),
          eq(organizationMembers.userId, projectMembers.userId)
        )
      )
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId)
        )
      )
      .limit(1);
    if (!membership)
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "You do not have access to this project."
      );
    return membership.membership;
  }

  private async withProjectReadLock<T>(
    projectId: string,
    read: (executor: Database) => Promise<T>
  ) {
    // ponytail: a shared project lock keeps authorization and enrichment atomic;
    // move to a single joined query if project chat read throughput becomes material.
    return this.db.transaction(async (tx) => {
      const [project] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .for("share");
      if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
      return read(tx as unknown as Database);
    });
  }

  private async projectIdForChat(chatId: string) {
    const [chat] = await this.db
      .select({ projectId: chats.projectId })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);
    if (!chat) throw new ApiError(404, "NOT_FOUND", "Chat not found.");
    return chat.projectId;
  }

  private async assertActorEligible(
    tx: Transaction,
    actor: Actor,
    projectId: string
  ) {
    if (actor.type === "human") {
      const [membership] = await tx
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.organizationId, projects.organizationId),
            eq(organizationMembers.userId, projectMembers.userId)
          )
        )
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, actor.id)
          )
        )
        .limit(1);
      if (!membership)
        throw new ApiError(
          403,
          "PERMISSION_DENIED",
          "You do not have access to this project."
        );
      return;
    }
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(
        agentCredentials,
        and(
          eq(agentCredentials.projectId, agents.projectId),
          eq(agentCredentials.agentId, agents.id)
        )
      )
      .where(
        and(
          eq(agents.projectId, projectId),
          eq(agents.id, actor.id),
          eq(agents.status, "active"),
          actor.credentialId
            ? eq(agentCredentials.id, actor.credentialId)
            : undefined,
          isNull(agentCredentials.revokedAt)
        )
      )
      .limit(1);
    if (!agent)
      throw new ApiError(
        401,
        "AGENT_CREDENTIAL_REVOKED",
        "Agent credential has been revoked."
      );
  }

  private async candidatesFor(
    executor: Database,
    projectId: string,
    refs?: ParticipantRef[]
  ) {
    const humanIds = refs
      ? refs.filter((value) => value.type === "human").map((value) => value.id)
      : null;
    const agentIds = refs
      ? refs.filter((value) => value.type === "agent").map((value) => value.id)
      : null;
    const humans =
      humanIds?.length === 0
        ? []
        : await executor
            .select({
              id: users.id,
              name: users.name,
              avatarUrl: users.avatarUrl
            })
            .from(projectMembers)
            .innerJoin(projects, eq(projects.id, projectMembers.projectId))
            .innerJoin(
              organizationMembers,
              and(
                eq(organizationMembers.organizationId, projects.organizationId),
                eq(organizationMembers.userId, projectMembers.userId)
              )
            )
            .innerJoin(users, eq(users.id, projectMembers.userId))
            .where(
              and(
                eq(projectMembers.projectId, projectId),
                humanIds ? inArray(projectMembers.userId, humanIds) : undefined
              )
            )
            .orderBy(asc(users.name), asc(users.id));
    const agentRows =
      agentIds?.length === 0
        ? []
        : await executor
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(
              and(
                eq(agents.projectId, projectId),
                eq(agents.status, "active"),
                agentIds ? inArray(agents.id, agentIds) : undefined
              )
            )
            .orderBy(asc(agents.name), asc(agents.id));
    return [
      ...humans.map((value): Candidate => ({
        type: "human",
        id: value.id,
        name: value.name,
        avatar_url: value.avatarUrl
      })),
      ...agentRows.map((value): Candidate => ({
        type: "agent",
        id: value.id,
        name: value.name,
        avatar_url: null
      }))
    ];
  }

  private async validateCandidates(
    tx: Transaction,
    projectId: string,
    refs: ParticipantRef[]
  ) {
    const unique = [
      ...new Map(refs.map((value) => [keyFor(value), value])).values()
    ];
    const candidates = await this.candidatesFor(
      tx as unknown as Database,
      projectId,
      unique
    );
    if (candidates.length !== unique.length)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Every participant must be an eligible member of this project."
      );
    return candidates;
  }

  async listCandidatesHuman(userId: string, projectId: string) {
    return this.withProjectReadLock(projectId, async (executor) => {
      await this.humanProject(userId, projectId, executor);
      return {
        candidates: (await this.candidatesFor(executor, projectId)).filter(
          (value) => value.type !== "human" || value.id !== userId
        )
      };
    });
  }

  async listCandidatesAgent(principal: AgentPrincipal) {
    return {
      candidates: (
        await this.candidatesFor(this.db, principal.projectId)
      ).filter(
        (value) => value.type !== "agent" || value.id !== principal.agentId
      )
    };
  }

  private async participantRows(executor: Database, chat: ChatRow) {
    const rows = await executor
      .select()
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, chat.id));
    const refs: ParticipantRef[] = rows.map((row) =>
      row.userId
        ? { type: "human", id: row.userId }
        : { type: "agent", id: row.agentId! }
    );
    const candidates = await this.candidatesFor(executor, chat.projectId, refs);
    const byKey = new Map(candidates.map((value) => [keyFor(value), value]));
    return rows.map((row) => {
      const ref: ParticipantRef = row.userId
        ? { type: "human", id: row.userId }
        : { type: "agent", id: row.agentId! };
      return {
        row,
        ref,
        candidate:
          byKey.get(keyFor(ref)) ??
          ({ ...ref, name: "Unknown", avatar_url: null } satisfies Candidate)
      };
    });
  }

  private canManage(chat: ChatRow, actor: Actor, isParticipant: boolean) {
    if (!isParticipant || chat.kind === "direct") return false;
    if (
      chat.creatorType === actor.type &&
      (chat.creatorUserId ?? chat.creatorAgentId) === actor.id
    )
      return true;
    return chat.creatorType === "agent" && actor.type === "human";
  }

  private async chatJson(executor: Database, chat: ChatRow, actor: Actor) {
    const participants = await this.participantRows(executor, chat);
    const membership = participants.find(
      (value) => keyFor(value.ref) === keyFor(actor)
    );
    let unreadCount = 0;
    let mentionCount = 0;
    const lastRead = membership?.row.lastReadSequence ?? 0;
    if (membership) {
      const unread = await executor
        .select({
          authorType: chatMessages.authorType,
          authorUserId: chatMessages.authorUserId,
          authorAgentId: chatMessages.authorAgentId,
          mentions: chatMessages.mentions
        })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.chatId, chat.id),
            gt(chatMessages.sequence, lastRead),
            actor.type === "human"
              ? or(
                  ne(chatMessages.authorType, "human"),
                  ne(chatMessages.authorUserId, actor.id)
                )
              : or(
                  ne(chatMessages.authorType, "agent"),
                  ne(chatMessages.authorAgentId, actor.id)
                )
          )
        );
      unreadCount = unread.length;
      mentionCount = unread.filter((message) =>
        message.mentions.some(
          (mention) => mention.type === actor.type && mention.id === actor.id
        )
      ).length;
    }
    return {
      id: chat.id,
      project_id: chat.projectId,
      kind: chat.kind,
      name: chat.name,
      has_human: chat.hasHuman,
      creator: {
        type: chat.creatorType,
        id: (chat.creatorUserId ?? chat.creatorAgentId)!
      },
      participants: participants.map((value) => value.candidate),
      is_participant: Boolean(membership),
      can_manage: this.canManage(chat, actor, Boolean(membership)),
      can_join:
        actor.type === "human" &&
        !membership &&
        chat.kind === "group" &&
        !chat.hasHuman,
      last_sequence: chat.lastSequence,
      last_read_sequence: lastRead,
      unread_count: unreadCount,
      mention_count: mentionCount,
      created_at: chat.createdAt.toISOString(),
      updated_at: chat.updatedAt.toISOString()
    };
  }

  private async visibleChatHuman(
    executor: Database,
    userId: string,
    chatId: string
  ) {
    const [chat] = await executor
      .select()
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);
    if (!chat) throw new ApiError(404, "NOT_FOUND", "Chat not found.");
    await this.humanProject(userId, chat.projectId, executor);
    const [participant] = await executor
      .select({ id: chatParticipants.id })
      .from(chatParticipants)
      .where(
        and(
          eq(chatParticipants.chatId, chat.id),
          eq(chatParticipants.userId, userId)
        )
      )
      .limit(1);
    if (!participant && chat.hasHuman)
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "You cannot access this chat."
      );
    return { chat, isParticipant: Boolean(participant) };
  }

  private async visibleChatAgent(
    executor: Database,
    principal: AgentPrincipal,
    chatId: string
  ) {
    const [chat] = await executor
      .select()
      .from(chats)
      .innerJoin(
        chatParticipants,
        and(
          eq(chatParticipants.chatId, chats.id),
          eq(chatParticipants.agentId, principal.agentId)
        )
      )
      .where(
        and(eq(chats.id, chatId), eq(chats.projectId, principal.projectId))
      )
      .limit(1);
    if (!chat)
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "You cannot access this chat."
      );
    return { chat: chat.chats, isParticipant: true };
  }

  async canHumanViewChat(userId: string, chatId: string) {
    try {
      await this.visibleChatHuman(this.db, userId, chatId);
      return true;
    } catch {
      return false;
    }
  }

  private async listAs(executor: Database, actor: Actor, projectId: string) {
    const memberships = await executor
      .select({ chatId: chatParticipants.chatId })
      .from(chatParticipants)
      .where(
        and(eq(chatParticipants.projectId, projectId), participantClause(actor))
      );
    const chatIds = memberships.map((value) => value.chatId);
    if (actor.type === "agent" && chatIds.length === 0) return { chats: [] };
    const rows = await executor
      .select()
      .from(chats)
      .where(
        and(
          eq(chats.projectId, projectId),
          actor.type === "human"
            ? or(
                eq(chats.hasHuman, false),
                chatIds.length ? inArray(chats.id, chatIds) : undefined
              )
            : inArray(chats.id, chatIds)
        )
      )
      .orderBy(desc(chats.updatedAt), desc(chats.id));
    return {
      chats: await Promise.all(
        rows.map((chat) => this.chatJson(executor, chat, actor))
      )
    };
  }

  async listHuman(userId: string, projectId: string) {
    return this.withProjectReadLock(projectId, async (executor) => {
      await this.humanProject(userId, projectId, executor);
      return this.listAs(executor, { type: "human", id: userId }, projectId);
    });
  }

  async listAgent(principal: AgentPrincipal) {
    return this.withProjectReadLock(principal.projectId, (executor) =>
      this.listAs(
        executor,
        { type: "agent", id: principal.agentId },
        principal.projectId
      )
    );
  }

  async getHuman(userId: string, chatId: string) {
    const projectId = await this.projectIdForChat(chatId);
    return this.withProjectReadLock(projectId, async (executor) => {
      const { chat } = await this.visibleChatHuman(executor, userId, chatId);
      return this.chatJson(executor, chat, { type: "human", id: userId });
    });
  }

  async getAgent(principal: AgentPrincipal, chatId: string) {
    return this.withProjectReadLock(principal.projectId, async (executor) => {
      const { chat } = await this.visibleChatAgent(executor, principal, chatId);
      return this.chatJson(executor, chat, {
        type: "agent",
        id: principal.agentId
      });
    });
  }

  private async reserveIdempotency(
    tx: Transaction,
    actor: Actor,
    operation: string,
    resourceId: string,
    key: string | undefined,
    requestHash: string
  ) {
    const idempotencyKey = idempotencyKeySchema.parse(key);
    const [reserved] = await tx
      .insert(apiIdempotencyKeys)
      .values({
        ...actorValues(actor),
        operation,
        resourceId,
        idempotencyKey,
        requestHash,
        responseStatus: 0,
        responseBody: {}
      })
      .onConflictDoNothing()
      .returning();
    if (reserved) return { reserved, existing: null };
    const [existing] = await tx
      .select()
      .from(apiIdempotencyKeys)
      .where(
        and(
          actorClause(actor),
          eq(apiIdempotencyKeys.operation, operation),
          eq(apiIdempotencyKeys.resourceId, resourceId),
          eq(apiIdempotencyKeys.idempotencyKey, idempotencyKey)
        )
      )
      .limit(1);
    if (!existing || existing.requestHash !== requestHash)
      throw new ApiError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used with a different request."
      );
    return { reserved: null, existing };
  }

  private async finishIdempotency(
    tx: Transaction,
    id: string,
    status: number,
    body: unknown
  ) {
    await tx
      .update(apiIdempotencyKeys)
      .set({ responseStatus: status, responseBody: body })
      .where(eq(apiIdempotencyKeys.id, id));
  }

  private async createAs(
    actor: Actor,
    projectId: string,
    input: CreateChatRequest,
    key?: string
  ) {
    const normalized = {
      ...input,
      participants: [...input.participants].sort((a, b) =>
        keyFor(a).localeCompare(keyFor(b))
      )
    };
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, projectId);
      await this.assertActorEligible(tx, actor, projectId);
      const idempotency = await this.reserveIdempotency(
        tx,
        actor,
        "create_chat",
        projectId,
        key,
        stableHash(normalized)
      );
      if (idempotency.existing) {
        const cached = idempotency.existing.responseBody as { id?: unknown };
        const [chat] =
          typeof cached.id === "string"
            ? await tx
                .select()
                .from(chats)
                .where(
                  and(eq(chats.id, cached.id), eq(chats.projectId, projectId))
                )
                .limit(1)
            : [];
        if (!chat)
          throw new ApiError(
            409,
            "CONFLICT",
            "The original chat is unavailable."
          );
        const [participant] = await tx
          .select({ id: chatParticipants.id })
          .from(chatParticipants)
          .where(
            and(eq(chatParticipants.chatId, chat.id), participantClause(actor))
          )
          .limit(1);
        if (!participant && (actor.type === "agent" || chat.hasHuman))
          throw new ApiError(
            403,
            "PERMISSION_DENIED",
            "You cannot access this chat."
          );
        return {
          status: idempotency.existing.responseStatus,
          body: await this.chatJson(tx as unknown as Database, chat, actor)
        };
      }

      const candidates = await this.validateCandidates(tx, projectId, [
        actor,
        ...input.participants
      ]);
      const refs = candidates.map(({ type, id }) => ({ type, id }));
      if (input.kind === "direct" && refs.length !== 2)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Direct messages must have exactly two different participants."
        );
      if (input.kind === "group" && refs.length < 2)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Groups must have at least two participants."
        );
      const directKey =
        input.kind === "direct" ? refs.map(keyFor).sort().join("|") : null;
      let chat: ChatRow | undefined;
      let status = 201;
      if (directKey) {
        [chat] = await tx
          .select()
          .from(chats)
          .where(
            and(eq(chats.projectId, projectId), eq(chats.directKey, directKey))
          )
          .limit(1);
        if (chat) {
          status = 200;
          const present = await tx
            .select()
            .from(chatParticipants)
            .where(eq(chatParticipants.chatId, chat.id));
          const presentKeys = new Set(
            present.map((value) =>
              keyFor(
                value.userId
                  ? { type: "human", id: value.userId }
                  : { type: "agent", id: value.agentId! }
              )
            )
          );
          const missing = refs.filter(
            (value) => !presentKeys.has(keyFor(value))
          );
          if (missing.length) {
            await tx.insert(chatParticipants).values(
              missing.map((value) => ({
                projectId,
                chatId: chat!.id,
                userId: value.type === "human" ? value.id : null,
                agentId: value.type === "agent" ? value.id : null
              }))
            );
            for (const participant of missing)
              await insertProjectEvent(tx, {
                projectId,
                ...eventActor(actor),
                entityId: chat.id,
                type: "chat.member_added",
                payload: { participant }
              });
          }
        }
      }
      if (!chat) {
        [chat] = await tx
          .insert(chats)
          .values({
            id: randomUUID(),
            projectId,
            kind: input.kind,
            name: input.kind === "group" ? input.name! : null,
            directKey,
            hasHuman: refs.some((value) => value.type === "human"),
            creatorType: actor.type,
            creatorUserId: actor.type === "human" ? actor.id : null,
            creatorAgentId: actor.type === "agent" ? actor.id : null
          })
          .returning();
        await tx.insert(chatParticipants).values(
          refs.map((value) => ({
            projectId,
            chatId: chat!.id,
            userId: value.type === "human" ? value.id : null,
            agentId: value.type === "agent" ? value.id : null
          }))
        );
        await insertProjectEvent(tx, {
          projectId,
          ...eventActor(actor),
          entityId: chat.id,
          type: "chat.created",
          payload: { kind: chat.kind }
        });
      }
      const body = await this.chatJson(tx as unknown as Database, chat, actor);
      await this.finishIdempotency(tx, idempotency.reserved!.id, status, body);
      return { status, body };
    });
  }

  async createHuman(
    userId: string,
    projectId: string,
    input: CreateChatRequest,
    key?: string
  ) {
    return this.createAs({ type: "human", id: userId }, projectId, input, key);
  }

  async createAgent(
    principal: AgentPrincipal,
    input: CreateChatRequest,
    key?: string
  ) {
    return this.createAs(
      {
        type: "agent",
        id: principal.agentId,
        credentialId: principal.credentialId
      },
      principal.projectId,
      input,
      key
    );
  }

  private async eligibleManagerCount(
    tx: Transaction,
    chat: ChatRow,
    excluding?: Actor
  ) {
    const participants = await tx
      .select()
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, chat.id));
    const present = (actor: Actor) =>
      participants.some(
        (value) =>
          keyFor(
            value.userId
              ? { type: "human", id: value.userId }
              : { type: "agent", id: value.agentId! }
          ) === keyFor(actor)
      ) &&
      (!excluding || keyFor(actor) !== keyFor(excluding));
    if (chat.creatorType === "human") {
      if (
        !chat.creatorUserId ||
        !present({ type: "human", id: chat.creatorUserId })
      )
        return 0;
      const [membership] = await tx
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.organizationId, projects.organizationId),
            eq(organizationMembers.userId, projectMembers.userId)
          )
        )
        .where(
          and(
            eq(projectMembers.projectId, chat.projectId),
            eq(projectMembers.userId, chat.creatorUserId)
          )
        );
      return membership ? 1 : 0;
    }
    let count = 0;
    if (
      chat.creatorAgentId &&
      present({ type: "agent", id: chat.creatorAgentId })
    ) {
      const [creator] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.projectId, chat.projectId),
            eq(agents.id, chat.creatorAgentId),
            eq(agents.status, "active")
          )
        );
      if (creator) count += 1;
    }
    const humanIds = participants
      .map((value) => value.userId)
      .filter((value): value is string => Boolean(value))
      .filter(
        (value) =>
          !excluding ||
          keyFor({ type: "human", id: value }) !== keyFor(excluding)
      );
    if (humanIds.length) {
      const members = await tx
        .select({ id: projectMembers.userId })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .innerJoin(
          organizationMembers,
          and(
            eq(organizationMembers.organizationId, projects.organizationId),
            eq(organizationMembers.userId, projectMembers.userId)
          )
        )
        .where(
          and(
            eq(projectMembers.projectId, chat.projectId),
            inArray(projectMembers.userId, humanIds)
          )
        );
      count += members.length;
    }
    return count;
  }

  async assertHumanMayLeaveProject(
    tx: Transaction,
    projectId: string,
    userId: string
  ) {
    return this.assertActorMayLeaveProject(tx, projectId, {
      type: "human",
      id: userId
    });
  }

  private async assertActorMayLeaveProject(
    tx: Transaction,
    projectId: string,
    actor: Actor
  ) {
    const rows = await tx
      .select({ chat: chats })
      .from(chats)
      .innerJoin(
        chatParticipants,
        and(eq(chatParticipants.chatId, chats.id), participantClause(actor))
      )
      .where(and(eq(chats.projectId, projectId), eq(chats.kind, "group")));
    for (const { chat } of rows) {
      if ((await this.eligibleManagerCount(tx, chat, actor)) === 0)
        throw new ApiError(
          409,
          "CONFLICT",
          "A group must retain at least one eligible manager."
        );
    }
  }

  private async recordInvalidation(
    tx: Transaction,
    chat: ChatRow,
    actor: Actor,
    audience: RealtimeAudience
  ) {
    const event = await insertProjectEvent(tx, {
      projectId: chat.projectId,
      ...eventActor(actor),
      entityId: chat.id,
      type: "chat.access_invalidated",
      publish: false
    });
    recordRealtimeNotice(
      tx,
      {
        project_id: chat.projectId,
        sequence: event.id,
        event_type: event.type,
        entity_type: "chat",
        entity_id: chat.id
      },
      audience
    );
  }

  private async manageAs(
    actor: Actor,
    projectId: string,
    chatId: string,
    input: ManageChatMembersRequest
  ) {
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, projectId);
      await this.assertActorEligible(tx, actor, projectId);
      let [chat] = await tx
        .select()
        .from(chats)
        .where(and(eq(chats.id, chatId), eq(chats.projectId, projectId)))
        .for("update");
      if (!chat) throw new ApiError(404, "NOT_FOUND", "Chat not found.");
      if (chat.kind === "direct")
        throw new ApiError(
          409,
          "CONFLICT",
          "Direct-message membership is fixed."
        );
      const [manager] = await tx
        .select({ id: chatParticipants.id })
        .from(chatParticipants)
        .where(
          and(eq(chatParticipants.chatId, chat.id), participantClause(actor))
        )
        .limit(1);
      if (!this.canManage(chat, actor, Boolean(manager)))
        throw new ApiError(
          403,
          "PERMISSION_DENIED",
          "You cannot manage this chat."
        );
      const [existing] = await tx
        .select()
        .from(chatParticipants)
        .where(
          and(
            eq(chatParticipants.chatId, chat.id),
            participantClause(input.participant)
          )
        )
        .limit(1);
      if (input.action === "add") {
        if (existing)
          throw new ApiError(
            409,
            "CONFLICT",
            "That participant is already in the chat."
          );
        await this.validateCandidates(tx, projectId, [input.participant]);
        await tx.insert(chatParticipants).values({
          projectId,
          chatId,
          userId:
            input.participant.type === "human" ? input.participant.id : null,
          agentId:
            input.participant.type === "agent" ? input.participant.id : null
        });
        const firstHuman = input.participant.type === "human" && !chat.hasHuman;
        if (firstHuman) {
          [chat] = await tx
            .update(chats)
            .set({ hasHuman: true, updatedAt: new Date() })
            .where(eq(chats.id, chat.id))
            .returning();
          await this.recordInvalidation(tx, chat, actor, {
            excludeUserIds: [input.participant.id]
          });
        }
      } else {
        if (!existing)
          throw new ApiError(
            404,
            "NOT_FOUND",
            "That participant is not in the chat."
          );
        if (
          (await this.eligibleManagerCount(tx, chat, input.participant)) === 0
        )
          throw new ApiError(
            409,
            "CONFLICT",
            "A group must retain at least one eligible manager."
          );
        await tx
          .delete(chatParticipants)
          .where(eq(chatParticipants.id, existing.id));
        if (input.participant.type === "human")
          await this.recordInvalidation(tx, chat, actor, {
            targetUserIds: [input.participant.id]
          });
      }
      await tx
        .update(chats)
        .set({ updatedAt: new Date() })
        .where(eq(chats.id, chat.id));
      await insertProjectEvent(tx, {
        projectId,
        ...eventActor(actor),
        entityId: chat.id,
        type:
          input.action === "add" ? "chat.member_added" : "chat.member_removed",
        payload: { participant: input.participant }
      });
      const [updated] = await tx
        .select()
        .from(chats)
        .where(eq(chats.id, chat.id));
      return this.chatJson(tx as unknown as Database, updated!, actor);
    });
  }

  async manageHuman(
    userId: string,
    chatId: string,
    input: ManageChatMembersRequest
  ) {
    const projectId = await this.projectIdForChat(chatId);
    return this.manageAs(
      { type: "human", id: userId },
      projectId,
      chatId,
      input
    );
  }

  async manageAgent(
    principal: AgentPrincipal,
    chatId: string,
    input: ManageChatMembersRequest
  ) {
    return this.manageAs(
      {
        type: "agent",
        id: principal.agentId,
        credentialId: principal.credentialId
      },
      principal.projectId,
      chatId,
      input
    );
  }

  async joinHuman(userId: string, chatId: string) {
    const projectId = await this.projectIdForChat(chatId);
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, projectId);
      await this.assertActorEligible(
        tx,
        { type: "human", id: userId },
        projectId
      );
      let [locked] = await tx
        .select()
        .from(chats)
        .where(and(eq(chats.id, chatId), eq(chats.projectId, projectId)))
        .for("update");
      if (!locked) throw new ApiError(404, "NOT_FOUND", "Chat not found.");
      const [participant] = await tx
        .select({ id: chatParticipants.id })
        .from(chatParticipants)
        .where(
          and(
            eq(chatParticipants.chatId, locked.id),
            eq(chatParticipants.userId, userId)
          )
        )
        .limit(1);
      if (participant)
        return this.chatJson(tx as unknown as Database, locked, {
          type: "human",
          id: userId
        });
      if (!locked || locked.kind !== "group" || locked.hasHuman)
        throw new ApiError(
          403,
          "PERMISSION_DENIED",
          "You cannot join this chat."
        );
      await tx.insert(chatParticipants).values({
        projectId: locked.projectId,
        chatId: locked.id,
        userId
      });
      [locked] = await tx
        .update(chats)
        .set({ hasHuman: true, updatedAt: new Date() })
        .where(eq(chats.id, locked.id))
        .returning();
      await this.recordInvalidation(
        tx,
        locked,
        { type: "human", id: userId },
        {
          excludeUserIds: [userId]
        }
      );
      await insertProjectEvent(tx, {
        projectId: locked.projectId,
        actorUserId: userId,
        entityId: locked.id,
        type: "chat.member_added",
        payload: { participant: { type: "human", id: userId } }
      });
      return this.chatJson(tx as unknown as Database, locked, {
        type: "human",
        id: userId
      });
    });
  }

  private messageJson(message: MessageRow) {
    return {
      id: message.id,
      chat_id: message.chatId,
      project_id: message.projectId,
      sequence: message.sequence,
      author: {
        type: message.authorType,
        id: (message.authorUserId ?? message.authorAgentId)!,
        name: message.authorName
      },
      body_markdown: message.bodyMarkdown,
      mentions: message.mentions,
      documents: message.documentRefs,
      created_at: message.createdAt.toISOString()
    };
  }

  private async messagesAs(
    executor: Database,
    actor: Actor,
    chat: ChatRow,
    isParticipant: boolean,
    query: ChatMessagesQuery
  ) {
    const [participant] = isParticipant
      ? await executor
          .select()
          .from(chatParticipants)
          .where(
            and(eq(chatParticipants.chatId, chat.id), participantClause(actor))
          )
          .limit(1)
      : [undefined];
    const clauses = [eq(chatMessages.chatId, chat.id)];
    let newestFirst = false;
    if (query.unread_only)
      clauses.push(
        gt(chatMessages.sequence, participant?.lastReadSequence ?? 0)
      );
    else if (query.after !== undefined)
      clauses.push(gt(chatMessages.sequence, query.after));
    else if (query.before !== undefined) {
      clauses.push(lt(chatMessages.sequence, query.before));
      newestFirst = true;
    } else newestFirst = true;
    const rows = await executor
      .select()
      .from(chatMessages)
      .where(and(...clauses))
      .orderBy(
        newestFirst ? desc(chatMessages.sequence) : asc(chatMessages.sequence)
      )
      .limit(query.limit + 1);
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    if (newestFirst) page.reverse();
    return {
      messages: page.map((message) => this.messageJson(message)),
      has_more: hasMore,
      next_after:
        !newestFirst && hasMore ? (page.at(-1)?.sequence ?? null) : null,
      next_before:
        newestFirst && hasMore ? (page.at(0)?.sequence ?? null) : null
    };
  }

  async messagesHuman(
    userId: string,
    chatId: string,
    query: ChatMessagesQuery
  ) {
    const projectId = await this.projectIdForChat(chatId);
    return this.withProjectReadLock(projectId, async (executor) => {
      const { chat, isParticipant } = await this.visibleChatHuman(
        executor,
        userId,
        chatId
      );
      return this.messagesAs(
        executor,
        { type: "human", id: userId },
        chat,
        isParticipant,
        query
      );
    });
  }

  async messagesAgent(
    principal: AgentPrincipal,
    chatId: string,
    query: ChatMessagesQuery
  ) {
    return this.withProjectReadLock(principal.projectId, async (executor) => {
      const { chat } = await this.visibleChatAgent(executor, principal, chatId);
      return this.messagesAs(
        executor,
        { type: "agent", id: principal.agentId },
        chat,
        true,
        query
      );
    });
  }

  private async sendAs(
    actor: Actor,
    projectId: string,
    chatId: string,
    input: SendMessageRequest,
    key?: string
  ) {
    const normalized = {
      ...input,
      mentions: [...input.mentions].sort((a, b) =>
        keyFor(a).localeCompare(keyFor(b))
      ),
      document_ids: [...input.document_ids].sort()
    };
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, projectId);
      await this.assertActorEligible(tx, actor, projectId);
      const [chat] = await tx
        .select()
        .from(chats)
        .where(and(eq(chats.id, chatId), eq(chats.projectId, projectId)))
        .for("update");
      if (!chat) throw new ApiError(404, "NOT_FOUND", "Chat not found.");
      const [participant] = await tx
        .select()
        .from(chatParticipants)
        .where(
          and(eq(chatParticipants.chatId, chat.id), participantClause(actor))
        );
      if (!participant)
        throw new ApiError(
          403,
          "PERMISSION_DENIED",
          "You cannot send to this chat."
        );
      const idempotency = await this.reserveIdempotency(
        tx,
        actor,
        "send_chat_message",
        chat.id,
        key,
        stableHash(normalized)
      );
      if (idempotency.existing)
        return {
          status: idempotency.existing.responseStatus,
          body: idempotency.existing.responseBody
        };

      const participants = await this.participantRows(
        tx as unknown as Database,
        chat
      );
      const participantByKey = new Map(
        participants.map((value) => [keyFor(value.ref), value.candidate])
      );
      const mentionRefs = [
        ...new Map(
          input.mentions.map((value) => [keyFor(value), value])
        ).values()
      ];
      const mentions = mentionRefs.map((value) =>
        participantByKey.get(keyFor(value))
      );
      if (mentions.some((value) => !value))
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Mentions must name current chat participants."
        );
      const documentIds = [...new Set(input.document_ids)];
      const documentRows = documentIds.length
        ? await tx
            .select({ id: documents.id, path: documents.path })
            .from(documents)
            .where(
              and(
                eq(documents.projectId, projectId),
                inArray(documents.id, documentIds)
              )
            )
        : [];
      if (documentRows.length !== documentIds.length)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Document references must belong to this project."
        );
      const author = participantByKey.get(keyFor(actor))!;
      const sequence = chat.lastSequence + 1;
      const [message] = await tx
        .insert(chatMessages)
        .values({
          id: randomUUID(),
          projectId,
          chatId,
          sequence,
          authorType: actor.type,
          authorUserId: actor.type === "human" ? actor.id : null,
          authorAgentId: actor.type === "agent" ? actor.id : null,
          authorName: author.name,
          bodyMarkdown: input.body_markdown,
          mentions: mentions as Candidate[],
          documentRefs: documentRows
        })
        .returning();
      await tx
        .update(chats)
        .set({ lastSequence: sequence, updatedAt: new Date() })
        .where(eq(chats.id, chat.id));
      const body = this.messageJson(message);
      await insertProjectEvent(tx, {
        projectId,
        ...eventActor(actor),
        entityId: chat.id,
        type: "chat.message_created",
        payload: {
          message_id: message.id,
          sequence,
          author: body.author,
          mentions: body.mentions.map(({ type, id }) => ({ type, id }))
        }
      });
      await this.finishIdempotency(tx, idempotency.reserved!.id, 201, body);
      return { status: 201, body };
    });
  }

  async sendHuman(
    userId: string,
    chatId: string,
    input: SendMessageRequest,
    key?: string
  ) {
    const projectId = await this.projectIdForChat(chatId);
    return this.sendAs(
      { type: "human", id: userId },
      projectId,
      chatId,
      input,
      key
    );
  }

  async sendAgent(
    principal: AgentPrincipal,
    chatId: string,
    input: SendMessageRequest,
    key?: string
  ) {
    return this.sendAs(
      {
        type: "agent",
        id: principal.agentId,
        credentialId: principal.credentialId
      },
      principal.projectId,
      chatId,
      input,
      key
    );
  }

  private async acknowledgeAs(
    actor: Actor,
    projectId: string,
    chatId: string,
    messageId: string
  ) {
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, projectId);
      await this.assertActorEligible(tx, actor, projectId);
      const [participant] = await tx
        .select()
        .from(chatParticipants)
        .where(
          and(
            eq(chatParticipants.projectId, projectId),
            eq(chatParticipants.chatId, chatId),
            participantClause(actor)
          )
        )
        .for("update");
      if (!participant)
        throw new ApiError(
          403,
          "PERMISSION_DENIED",
          "You cannot acknowledge this chat."
        );
      const [message] = await tx
        .select({ sequence: chatMessages.sequence })
        .from(chatMessages)
        .where(
          and(eq(chatMessages.chatId, chatId), eq(chatMessages.id, messageId))
        )
        .limit(1);
      if (!message) throw new ApiError(404, "NOT_FOUND", "Message not found.");
      const lastReadSequence = Math.max(
        participant.lastReadSequence,
        message.sequence
      );
      if (lastReadSequence !== participant.lastReadSequence)
        await tx
          .update(chatParticipants)
          .set({ lastReadSequence })
          .where(eq(chatParticipants.id, participant.id));
      return { last_read_sequence: lastReadSequence };
    });
  }

  async acknowledgeHuman(userId: string, chatId: string, messageId: string) {
    const projectId = await this.projectIdForChat(chatId);
    return this.acknowledgeAs(
      { type: "human", id: userId },
      projectId,
      chatId,
      messageId
    );
  }

  async acknowledgeAgent(
    principal: AgentPrincipal,
    chatId: string,
    messageId: string
  ) {
    return this.acknowledgeAs(
      {
        type: "agent",
        id: principal.agentId,
        credentialId: principal.credentialId
      },
      principal.projectId,
      chatId,
      messageId
    );
  }

  private async inboxAs(executor: Database, actor: Actor, projectId: string) {
    const unreadChats = await executor
      .select({
        chatId: chatParticipants.chatId,
        unreadCount: count(chatMessages.id),
        mentionCount:
          sql<number>`sum(case when ${chatMessages.mentions} @> ${JSON.stringify(
            [{ type: actor.type, id: actor.id }]
          )}::jsonb then 1 else 0 end)`.mapWith(Number)
      })
      .from(chatParticipants)
      .innerJoin(
        chats,
        and(
          eq(chats.id, chatParticipants.chatId),
          eq(chats.projectId, projectId)
        )
      )
      .innerJoin(
        chatMessages,
        and(
          eq(chatMessages.chatId, chatParticipants.chatId),
          eq(chatMessages.projectId, projectId),
          gt(chatMessages.sequence, chatParticipants.lastReadSequence),
          actor.type === "human"
            ? or(
                ne(chatMessages.authorType, "human"),
                ne(chatMessages.authorUserId, actor.id)
              )
            : or(
                ne(chatMessages.authorType, "agent"),
                ne(chatMessages.authorAgentId, actor.id)
              )
        )
      )
      .where(
        and(eq(chatParticipants.projectId, projectId), participantClause(actor))
      )
      .groupBy(chatParticipants.chatId, chats.updatedAt, chats.id)
      .orderBy(desc(chats.updatedAt), desc(chats.id));
    return {
      unread_chats: unreadChats.map((chat) => ({
        chat_id: chat.chatId,
        unread_count: chat.unreadCount,
        mention_count: chat.mentionCount
      }))
    };
  }

  async inboxHuman(userId: string, projectId: string) {
    return this.withProjectReadLock(projectId, async (executor) => {
      await this.humanProject(userId, projectId, executor);
      return this.inboxAs(executor, { type: "human", id: userId }, projectId);
    });
  }

  async inboxAgent(principal: AgentPrincipal) {
    return this.withProjectReadLock(principal.projectId, (executor) =>
      this.inboxAs(
        executor,
        { type: "agent", id: principal.agentId },
        principal.projectId
      )
    );
  }
}
