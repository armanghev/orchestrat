import { createHash, randomUUID } from "node:crypto";
import {
  agents,
  apiIdempotencyKeys,
  chatMessages,
  chatParticipants,
  chats,
  handoffs,
  projectEvents,
  projects,
  taskComments,
  tasks,
  users,
  type Database
} from "@orchestrat/db";
import type {
  AttentionActor,
  AttentionTaskRef,
  CreateChatRequest,
  CreateHandoffRequest,
  CreateHandoffResponse,
  Handoff,
  ParticipantRef,
  RecordWakeRequest,
  RecordWakeResponse,
  SendMessageRequest
} from "@orchestrat/protocol";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
  type AnyColumn
} from "drizzle-orm";
import {
  insertProjectEvent,
  type AgentPrincipal,
  type Transaction
} from "./agent-service.js";
import { ApiError } from "./api-error.js";
import { resolveBranch, type BranchSelector } from "./branch-context.js";
import {
  ensureWatch,
  latestCommentSequence,
  type Actor
} from "./attention-hooks.js";
import type { ChatService } from "./chat-service.js";
import { resolveBlocksOnParticipantResponse } from "./task-block-hooks.js";

// Server constants (spec §11.1, §11.4, §19.5). Tuning is a one-line change.
export const handoffLimits = {
  maxHop: 4,
  perSenderPerHour: 20,
  perPairPerHour: 6,
  perProjectPerHour: 200
};
export const wakeLimits = { perHour: 12, perDay: 30 };
const hourMs = 60 * 60_000;
const dayMs = 24 * hourMs;
// A handoff inherits the sender's latest incoming chain within this window.
const chainWindowMs = hourMs;

type Executor = Database | Transaction;
type HandoffRow = typeof handoffs.$inferSelect;
type ChatResult = { status: number; body: { id: string } };
type SendResult = { status: number; body: unknown };
// The ChatService entry points for one sender kind; they carry the sender's
// own access checks (membership or an unrevoked credential).
type Via = {
  /** The branch the sender works on; the handoff's DM and task live there. */
  branchId(): Promise<string>;
  candidates(): Promise<{ candidates: ParticipantRef[] }>;
  directChat(input: CreateChatRequest, key: string): Promise<ChatResult>;
  send(
    chatId: string,
    input: SendMessageRequest,
    key: string
  ): Promise<SendResult>;
};

// Chat and message keys derive from the handoff key, so a retry reuses the
// same direct chat and never sends a second message.
const derivedKey = (key: string, purpose: "chat" | "message") =>
  `handoff-${purpose}:${createHash("sha256").update(`${key}:${purpose}`).digest("hex")}`;
const fromClause = (actor: Actor) =>
  actor.type === "human"
    ? eq(handoffs.fromUserId, actor.id)
    : eq(handoffs.fromAgentId, actor.id);
const toClause = (actor: Actor) =>
  actor.type === "human"
    ? eq(handoffs.toUserId, actor.id)
    : eq(handoffs.toAgentId, actor.id);
const idempotencyActorClause = (actor: Actor) =>
  actor.type === "human"
    ? and(
        eq(apiIdempotencyKeys.userId, actor.id),
        isNull(apiIdempotencyKeys.agentId)
      )!
    : and(
        eq(apiIdempotencyKeys.agentId, actor.id),
        isNull(apiIdempotencyKeys.userId)
      )!;
const mentions = (column: AnyColumn, agentId: string) =>
  sql`${column} @> ${JSON.stringify([{ type: "agent", id: agentId }])}::jsonb`;
const messageBody = (task: AttentionTaskRef | null, body: string) =>
  task
    ? `**Handoff** · ${task.key} ${task.title}\n\n${body}`
    : `**Handoff**\n\n${body}`;
const askHuman = "Ask a human how to proceed instead of handing off again.";

async function lockActiveProject(tx: Transaction, projectId: string) {
  const [project] = await tx
    .select({ id: projects.id, status: projects.status })
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
}

async function projectTask(
  executor: Executor,
  projectId: string,
  taskId: string
): Promise<AttentionTaskRef> {
  const [task] = await executor
    .select({ id: tasks.id, key: tasks.taskKey, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
    .limit(1);
  if (!task) throw new ApiError(404, "NOT_FOUND", "Task not found.");
  return task;
}

// A human who messaged the agent directly, or mentioned it in a chat or a
// task comment, after `since` has stepped into the loop (spec §11.1).
async function humanContactSince(
  executor: Executor,
  projectId: string,
  agentId: string,
  since: Date
) {
  const [message] = await executor
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .innerJoin(chats, eq(chats.id, chatMessages.chatId))
    .innerJoin(
      chatParticipants,
      and(
        eq(chatParticipants.chatId, chatMessages.chatId),
        eq(chatParticipants.agentId, agentId)
      )
    )
    .where(
      and(
        eq(chatMessages.projectId, projectId),
        eq(chatMessages.authorType, "human"),
        gt(chatMessages.createdAt, since),
        or(eq(chats.kind, "direct"), mentions(chatMessages.mentions, agentId))
      )
    )
    .limit(1);
  if (message) return true;
  const [comment] = await executor
    .select({ id: taskComments.id })
    .from(taskComments)
    .where(
      and(
        eq(taskComments.projectId, projectId),
        eq(taskComments.authorType, "human"),
        gt(taskComments.createdAt, since),
        mentions(taskComments.mentions, agentId)
      )
    )
    .limit(1);
  return Boolean(comment);
}

// Chain inheritance: an agent's handoff continues its most recent incoming
// chain from the last hour unless a human stepped in since. Human-sent
// handoffs always start a chain; chainId null means "new chain".
async function chainFor(executor: Executor, projectId: string, sender: Actor) {
  if (sender.type === "human") return { chainId: null, hop: 0 };
  const [incoming] = await executor
    .select()
    .from(handoffs)
    .where(
      and(
        eq(handoffs.projectId, projectId),
        eq(handoffs.toAgentId, sender.id),
        gt(handoffs.createdAt, new Date(Date.now() - chainWindowMs))
      )
    )
    .orderBy(desc(handoffs.createdAt), desc(handoffs.id))
    .limit(1);
  if (
    !incoming ||
    (await humanContactSince(
      executor,
      projectId,
      sender.id,
      incoming.createdAt
    ))
  )
    return { chainId: null, hop: 0 };
  return { chainId: incoming.chainId, hop: incoming.hop + 1 };
}

// Counts come from handoffs rows, so limits survive restarts (spec §11.1).
async function assertWithinLimits(
  executor: Executor,
  projectId: string,
  from: Actor,
  to: Actor,
  hop: number
) {
  if (hop > handoffLimits.maxHop)
    throw new ApiError(
      429,
      "HANDOFF_CHAIN_LIMIT",
      `This handoff chain reached its limit of ${handoffLimits.maxHop} hops. ${askHuman}`,
      { hop, max_hop: handoffLimits.maxHop }
    );
  const since = new Date(Date.now() - hourMs);
  const recent = async (where?: ReturnType<typeof and>) => {
    const [row] = await executor
      .select({ value: count() })
      .from(handoffs)
      .where(
        and(
          eq(handoffs.projectId, projectId),
          gt(handoffs.createdAt, since),
          where
        )
      );
    return Number(row?.value ?? 0);
  };
  const limited = (scope: string, limit: number, message: string) =>
    new ApiError(429, "HANDOFF_RATE_LIMITED", `${message} ${askHuman}`, {
      scope,
      limit,
      window_seconds: hourMs / 1000
    });
  if (
    (await recent(and(fromClause(from), toClause(to)))) >=
    handoffLimits.perPairPerHour
  )
    throw limited(
      "pair",
      handoffLimits.perPairPerHour,
      `You already sent ${handoffLimits.perPairPerHour} handoffs to this recipient in the last hour.`
    );
  if ((await recent(fromClause(from))) >= handoffLimits.perSenderPerHour)
    throw limited(
      "sender",
      handoffLimits.perSenderPerHour,
      `You already sent ${handoffLimits.perSenderPerHour} handoffs in the last hour.`
    );
  if ((await recent()) >= handoffLimits.perProjectPerHour)
    throw limited(
      "project",
      handoffLimits.perProjectPerHour,
      `This project reached ${handoffLimits.perProjectPerHour} handoffs in the last hour.`
    );
}

export class HandoffService {
  constructor(
    protected readonly db: Database,
    protected readonly chats: ChatService
  ) {}

  async createAgent(
    principal: AgentPrincipal,
    input: CreateHandoffRequest,
    key: string
  ): Promise<{ status: number; body: CreateHandoffResponse }> {
    return this.createAs(
      { type: "agent", id: principal.agentId },
      principal.projectId,
      input,
      key,
      {
        branchId: async () =>
          (
            await resolveBranch(
              this.db,
              principal.projectId,
              principal.branch,
              { agentId: principal.agentId }
            )
          ).id,
        candidates: () => this.chats.listCandidatesAgent(principal),
        directChat: (chat, chatKey) =>
          this.chats.createAgent(principal, chat, chatKey),
        send: (chatId, message, messageKey) =>
          this.chats.sendAgent(principal, chatId, message, messageKey)
      }
    );
  }

  async createHuman(
    userId: string,
    projectId: string,
    input: CreateHandoffRequest,
    key: string,
    selector?: BranchSelector
  ): Promise<{ status: number; body: CreateHandoffResponse }> {
    return this.createAs({ type: "human", id: userId }, projectId, input, key, {
      branchId: async () =>
        (await resolveBranch(this.db, projectId, selector)).id,
      candidates: () => this.chats.listCandidatesHuman(userId, projectId),
      directChat: (chat, chatKey) =>
        this.chats.createHuman(userId, projectId, chat, chatKey),
      send: (chatId, message, messageKey) =>
        this.chats.sendHuman(userId, chatId, message, messageKey)
    });
  }

  // Spec §11.1: the direct chat and message go through ChatService (its
  // canonicalization, idempotency, unread state and events), then a second
  // transaction records the handoff row.
  private async createAs(
    sender: Actor,
    projectId: string,
    input: CreateHandoffRequest,
    key: string,
    via: Via
  ) {
    const to: Actor = { type: input.to.type, id: input.to.id };
    if (to.type === sender.type && to.id === sender.id)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "You cannot hand off to yourself."
      );
    // Candidates exclude the sender and revoked agents; the human listing
    // also checks project membership.
    const { candidates } = await via.candidates();
    if (
      !candidates.some((value) => value.type === to.type && value.id === to.id)
    )
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Handoffs must go to a member or active agent of this project."
      );
    const task = input.task_id
      ? await projectTask(this.db, projectId, input.task_id)
      : null;
    // The handoff's DM goes out on the sender's branch; its task must be there.
    const branchId = await via.branchId();
    if (task) {
      const [owner] = await this.db
        .select({ branchId: tasks.branchId })
        .from(tasks)
        .where(eq(tasks.id, task.id));
      if (owner?.branchId !== branchId)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Hand off a task from the branch it is on.",
          { reason: "cross_branch" }
        );
    }
    const messageKey = derivedKey(key, "message");
    // Refuse before the DM goes out. A retry whose message was already sent
    // skips this: the insert transaction below completes or refuses it.
    if (!(await this.messageSent(sender, messageKey))) {
      const chain = await chainFor(this.db, projectId, sender);
      await assertWithinLimits(this.db, projectId, sender, to, chain.hop);
    }
    const chat = await via.directChat(
      { kind: "direct", participants: [input.to] },
      derivedKey(key, "chat")
    );
    const sent = await via.send(
      chat.body.id,
      {
        body_markdown: messageBody(task, input.body_markdown),
        mentions: [],
        document_ids: []
      },
      messageKey
    );
    const message = sent.body as { id: string; sequence: number };
    return this.db.transaction(async (tx) => {
      await lockActiveProject(tx, projectId);
      const [existing] = await tx
        .select()
        .from(handoffs)
        .where(eq(handoffs.messageId, message.id))
        .limit(1);
      if (existing)
        return {
          status: 201,
          body: { handoff: await this.handoffJson(tx, existing) }
        };
      if (task) await projectTask(tx, projectId, task.id);
      const chain = await chainFor(tx, projectId, sender);
      // ponytail: the pre-check above refuses before the DM is sent. A
      // concurrent handoff that slips past it is refused here, after the DM
      // went out: the message stays as a plain DM with no handoff row, and a
      // retry with the same key re-checks without sending again. Move the
      // send into this transaction if that window ever matters.
      await assertWithinLimits(tx, projectId, sender, to, chain.hop);
      const id = randomUUID();
      const [row] = await tx
        .insert(handoffs)
        .values({
          id,
          projectId,
          chatId: chat.body.id,
          messageId: message.id,
          messageSequence: message.sequence,
          fromUserId: sender.type === "human" ? sender.id : null,
          fromAgentId: sender.type === "agent" ? sender.id : null,
          toUserId: to.type === "human" ? to.id : null,
          toAgentId: to.type === "agent" ? to.id : null,
          taskId: task?.id ?? null,
          chainId: chain.chainId ?? id,
          hop: chain.hop
        })
        .returning();
      if (task) {
        // The handoff is the attention item; earlier comments are history.
        await ensureWatch(tx, {
          projectId,
          taskId: task.id,
          actor: to,
          reason: "handoff",
          lastReadSequence: await latestCommentSequence(tx, task.id)
        });
        await resolveBlocksOnParticipantResponse(tx, {
          projectId,
          taskId: task.id,
          participant: sender,
          to
        });
      }
      // Entity chat: chat privacy authorization applies to the event as is.
      await insertProjectEvent(tx, {
        projectId,
        actorUserId: sender.type === "human" ? sender.id : null,
        actorAgentId: sender.type === "agent" ? sender.id : null,
        entityId: chat.body.id,
        branchId,
        type: "chat.handoff_created",
        payload: {
          message_id: message.id,
          handoff_id: id,
          participant: to,
          task_id: task?.id ?? null,
          hop: chain.hop
        }
      });
      return {
        status: 201,
        body: { handoff: await this.handoffJson(tx, row) }
      };
    });
  }

  private async messageSent(sender: Actor, messageKey: string) {
    const [row] = await this.db
      .select({ status: apiIdempotencyKeys.responseStatus })
      .from(apiIdempotencyKeys)
      .where(
        and(
          idempotencyActorClause(sender),
          eq(apiIdempotencyKeys.operation, "send_chat_message"),
          eq(apiIdempotencyKeys.idempotencyKey, messageKey)
        )
      )
      .limit(1);
    return Boolean(row && row.status > 0);
  }

  private async handoffJson(
    executor: Executor,
    row: HandoffRow
  ): Promise<Handoff> {
    const from: Actor = row.fromUserId
      ? { type: "human", id: row.fromUserId }
      : { type: "agent", id: row.fromAgentId! };
    const to: Actor = row.toUserId
      ? { type: "human", id: row.toUserId }
      : { type: "agent", id: row.toAgentId! };
    const refs = [from, to];
    const userIds = refs
      .filter((ref) => ref.type === "human")
      .map((ref) => ref.id);
    const agentIds = refs
      .filter((ref) => ref.type === "agent")
      .map((ref) => ref.id);
    const names = new Map<string, string>([
      ...(userIds.length
        ? await executor
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, userIds))
        : []
      ).map((value): [string, string] => [`human:${value.id}`, value.name]),
      ...(agentIds.length
        ? await executor
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(
              and(
                eq(agents.projectId, row.projectId),
                inArray(agents.id, agentIds)
              )
            )
        : []
      ).map((value): [string, string] => [`agent:${value.id}`, value.name])
    ]);
    const actor = (ref: Actor): AttentionActor => ({
      ...ref,
      name: names.get(`${ref.type}:${ref.id}`) ?? ""
    });
    return {
      id: row.id,
      chat_id: row.chatId,
      message_id: row.messageId,
      message_sequence: row.messageSequence,
      from: actor(from),
      to: actor(to),
      task: row.taskId
        ? await projectTask(executor, row.projectId, row.taskId)
        : null,
      chain_id: row.chainId,
      hop: row.hop,
      created_at: row.createdAt.toISOString()
    };
  }

  // Spec §11.4 server budget: 12 wakes per agent per hour, 30 per day, and
  // one per (chain, recipient). The woken agent's own credential records it.
  async recordWake(
    principal: AgentPrincipal,
    input: RecordWakeRequest
  ): Promise<RecordWakeResponse> {
    return this.db.transaction(async (tx) => {
      await lockActiveProject(tx, principal.projectId);
      const [handoff] = input.handoff_id
        ? await tx
            .select()
            .from(handoffs)
            .where(
              and(
                eq(handoffs.id, input.handoff_id),
                eq(handoffs.projectId, principal.projectId),
                eq(handoffs.toAgentId, principal.agentId)
              )
            )
            .limit(1)
        : [];
      if (input.handoff_id && !handoff)
        throw new ApiError(404, "NOT_FOUND", "Handoff not found.");
      const now = Date.now();
      // At most perDay rows ever match, because this budget refuses more.
      const recent = await tx
        .select({
          occurredAt: projectEvents.occurredAt,
          payload: projectEvents.payload
        })
        .from(projectEvents)
        .where(
          and(
            eq(projectEvents.projectId, principal.projectId),
            eq(projectEvents.type, "run.woken"),
            eq(projectEvents.entityId, principal.agentId),
            gt(projectEvents.occurredAt, new Date(now - dayMs))
          )
        );
      const limited = (message: string, details: Record<string, unknown>) =>
        new ApiError(429, "WAKE_LIMIT", message, details);
      const lastHour = recent.filter(
        (event) => event.occurredAt.getTime() > now - hourMs
      ).length;
      if (lastHour >= wakeLimits.perHour)
        throw limited(
          `This agent was already woken ${wakeLimits.perHour} times in the last hour.`,
          { scope: "hour", limit: wakeLimits.perHour }
        );
      if (recent.length >= wakeLimits.perDay)
        throw limited(
          `This agent was already woken ${wakeLimits.perDay} times in the last day.`,
          { scope: "day", limit: wakeLimits.perDay }
        );
      if (handoff) {
        // A chain has at most maxHop + 1 handoffs, each within an hour of
        // the previous one, so the day window covers every earlier wake.
        const wokenFor = recent
          .map((event) => event.payload.handoff_id)
          .filter((value): value is string => typeof value === "string");
        const [sameChain] = wokenFor.length
          ? await tx
              .select({ id: handoffs.id })
              .from(handoffs)
              .where(
                and(
                  inArray(handoffs.id, wokenFor),
                  eq(handoffs.chainId, handoff.chainId)
                )
              )
              .limit(1)
          : [];
        if (sameChain)
          throw limited(
            "This agent was already woken for this handoff chain.",
            { scope: "chain", chain_id: handoff.chainId }
          );
      }
      const event = await insertProjectEvent(tx, {
        projectId: principal.projectId,
        actorAgentId: principal.agentId,
        entityId: principal.agentId,
        type: "run.woken",
        payload: {
          integration: input.integration,
          handoff_id: handoff?.id ?? null,
          hop: handoff?.hop ?? null
        }
      });
      return { wake_event_id: event.id };
    });
  }
}
