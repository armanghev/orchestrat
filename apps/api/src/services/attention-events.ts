import {
  agents,
  chatMessages,
  chatParticipants,
  chats,
  projectEvents,
  taskBlocks,
  taskClaims,
  taskComments,
  taskWatches,
  tasks,
  users,
  type Database
} from "@orchestrat/db";
import {
  taskStatusSchema,
  type AttentionActor,
  type TaskStatus,
  type WaitEvent,
  type WaitEventKind
} from "@orchestrat/protocol";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { AgentPrincipal } from "./agent-service.js";
import { excerpt } from "./attention-guard.js";

// Spec §10: one classification pass scans at most this many project events.
export const waitScanLimit = 500;

// Event types that can classify for some agent. The hub skips waking waiters
// for anything else.
export const attentionEventTypes: ReadonlySet<string> = new Set([
  "chat.message_created",
  "chat.handoff_created",
  "task.comment_created",
  "claim.released",
  "claim.expired",
  "claim.revoked",
  "task.status_changed",
  "task.moved",
  "claim.completed",
  "task.block_resolved"
]);
const claimEndTypes = new Set([
  "claim.released",
  "claim.expired",
  "claim.revoked"
]);
const statusTypes = new Set([
  "task.status_changed",
  "task.moved",
  "claim.completed"
]);
const bodyPrefix = sql`2000`;

type EventRow = typeof projectEvents.$inferSelect;
type Ref = { type: "human" | "agent"; id: string };
// A preliminary classification; `requires` names the per-agent lookup that
// must pass before it becomes an event.
type Candidate = {
  event: EventRow;
  kind: WaitEventKind;
  requires?: "watching" | "own_block";
  taskId?: string;
  chatId?: string;
  messageId?: string;
  commentId?: string;
  commentSequence?: number;
  handoffId?: string;
  blockId?: string;
  fromStatus?: TaskStatus;
  toStatus?: TaskStatus;
};

const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;
const status = (value: unknown) => {
  const parsed = taskStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
const refs = (value: unknown): Ref[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Ref =>
          typeof item === "object" &&
          item !== null &&
          (item.type === "human" || item.type === "agent") &&
          typeof item.id === "string"
      )
    : [];
const unique = (values: (string | undefined)[]) => [
  ...new Set(values.filter((value): value is string => value !== undefined))
];

// Classifies project events after `after` for one agent (spec §10). Its own
// actions are skipped, chat events need a current participant row (the same
// privacy rule as AgentService.listEvents), and the returned cursor is the
// last id scanned, so events are never rescanned. `more` reports that the
// scan stopped early (event limit or scan limit) and newer events remain.
export async function classifyEventsSince(
  db: Database,
  principal: AgentPrincipal,
  after: number,
  opts: { directedOnly: boolean; kinds?: WaitEventKind[]; limit: number }
): Promise<{ events: WaitEvent[]; cursor: string; more: boolean }> {
  const agentId = principal.agentId;
  const rows = await db
    .select({
      event: projectEvents,
      chatKind: chats.kind,
      participantId: chatParticipants.id
    })
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
        eq(chatParticipants.agentId, agentId)
      )
    )
    .where(
      and(
        eq(projectEvents.projectId, principal.projectId),
        gt(projectEvents.id, after)
      )
    )
    .orderBy(asc(projectEvents.id))
    .limit(waitScanLimit);

  const mine = (ref: Ref | undefined) =>
    ref?.type === "agent" && ref.id === agentId;
  // A handoff's message is also a direct message; report it once, as the handoff.
  const handoffMessages = new Set(
    rows.flatMap(({ event, participantId }) =>
      event.type === "chat.handoff_created" &&
      participantId &&
      mine(event.payload.participant as Ref | undefined)
        ? unique([text(event.payload.message_id)])
        : []
    )
  );
  const candidates = new Map<number, Candidate>();
  for (const { event, chatKind, participantId } of rows) {
    if (event.actorAgentId === agentId) continue;
    const payload = event.payload;
    const taskId = text(payload.task_id);
    if (event.type === "chat.message_created") {
      const messageId = text(payload.message_id);
      if (!participantId || !messageId || handoffMessages.has(messageId))
        continue;
      const mentioned = refs(payload.mentions).some(mine);
      if (chatKind !== "direct" && !mentioned) continue;
      candidates.set(event.id, {
        event,
        kind: chatKind === "direct" ? "direct_message" : "mention",
        chatId: event.entityId ?? undefined,
        messageId
      });
    } else if (event.type === "chat.handoff_created") {
      if (!participantId || !mine(payload.participant as Ref | undefined))
        continue;
      candidates.set(event.id, {
        event,
        kind: "handoff",
        taskId,
        chatId: event.entityId ?? undefined,
        messageId: text(payload.message_id),
        handoffId: text(payload.handoff_id)
      });
    } else if (event.type === "task.comment_created") {
      if (!taskId) continue;
      const mentioned = refs(payload.mentions).some(mine);
      const sequence = payload.sequence;
      candidates.set(event.id, {
        event,
        kind: mentioned ? "mention" : "task_comment",
        requires: mentioned ? undefined : "watching",
        taskId,
        commentId: event.entityId ?? undefined,
        commentSequence:
          typeof sequence === "number" &&
          Number.isInteger(sequence) &&
          sequence > 0
            ? sequence
            : undefined
      });
    } else if (claimEndTypes.has(event.type)) {
      // An expired claim has no actor; skip the agent's own lapsed claim.
      if (!taskId || text(payload.agent_id) === agentId) continue;
      candidates.set(event.id, {
        event,
        kind: "claim_released",
        requires: "watching",
        taskId
      });
    } else if (statusTypes.has(event.type)) {
      const id =
        taskId ?? (event.type.startsWith("task.") ? event.entityId : null);
      if (!id) continue;
      candidates.set(event.id, {
        event,
        kind: "status_changed",
        requires: "watching",
        taskId: id,
        fromStatus: status(payload.from_status),
        toStatus:
          status(payload.to_status) ??
          (event.type === "claim.completed" ? "done" : undefined)
      });
    } else if (event.type === "task.block_resolved") {
      const blockId = text(payload.block_id) ?? event.entityId ?? undefined;
      if (!blockId) continue;
      candidates.set(event.id, {
        event,
        kind: "blocker_resolved",
        requires: "own_block",
        blockId,
        toStatus: status(payload.to_status)
      });
    }
  }

  const found = [...candidates.values()];
  const blockIds = unique(found.map((item) => item.blockId));
  const blocks = new Map(
    (blockIds.length
      ? await db
          .select({
            id: taskBlocks.id,
            taskId: taskBlocks.taskId,
            createdByAgentId: taskBlocks.createdByAgentId
          })
          .from(taskBlocks)
          .where(
            and(
              inArray(taskBlocks.id, blockIds),
              eq(taskBlocks.projectId, principal.projectId)
            )
          )
      : []
    ).map((block) => [block.id, block])
  );
  for (const item of found)
    if (item.blockId) item.taskId = blocks.get(item.blockId)?.taskId;
  const taskIds = unique(found.map((item) => item.taskId));
  const commentIds = unique(found.map((item) => item.commentId));
  const messageIds = unique(found.map((item) => item.messageId));
  const agentIds = unique(
    found.map((item) => item.event.actorAgentId ?? undefined)
  );
  const userIds = unique(
    found.map((item) => item.event.actorUserId ?? undefined)
  );
  const [
    watched,
    claimed,
    taskRows,
    commentRows,
    messageRows,
    agentRows,
    userRows
  ] = await Promise.all([
    taskIds.length
      ? db
          .select({
            taskId: taskWatches.taskId,
            lastRead: taskWatches.lastReadSequence
          })
          .from(taskWatches)
          .where(
            and(
              eq(taskWatches.projectId, principal.projectId),
              eq(taskWatches.agentId, agentId),
              isNull(taskWatches.userId),
              eq(taskWatches.state, "watching"),
              inArray(taskWatches.taskId, taskIds)
            )
          )
      : [],
    opts.directedOnly && taskIds.length
      ? db
          .select({ taskId: taskClaims.taskId })
          .from(taskClaims)
          .where(
            and(
              eq(taskClaims.projectId, principal.projectId),
              eq(taskClaims.agentId, agentId),
              eq(taskClaims.status, "active")
            )
          )
      : [],
    taskIds.length
      ? db
          .select({ id: tasks.id, key: tasks.taskKey, title: tasks.title })
          .from(tasks)
          .where(
            and(
              inArray(tasks.id, taskIds),
              eq(tasks.projectId, principal.projectId)
            )
          )
      : [],
    commentIds.length
      ? db
          .select({
            id: taskComments.id,
            body: sql<string>`left(${taskComments.bodyMarkdown}, ${bodyPrefix})`
          })
          .from(taskComments)
          .where(
            and(
              inArray(taskComments.id, commentIds),
              eq(taskComments.projectId, principal.projectId)
            )
          )
      : [],
    messageIds.length
      ? db
          .select({
            id: chatMessages.id,
            body: sql<string>`left(${chatMessages.bodyMarkdown}, ${bodyPrefix})`
          })
          .from(chatMessages)
          .where(
            and(
              inArray(chatMessages.id, messageIds),
              eq(chatMessages.projectId, principal.projectId)
            )
          )
      : [],
    agentIds.length
      ? db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, agentIds))
      : [],
    userIds.length
      ? db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, userIds))
      : []
  ]);
  const watching = new Map(watched.map((row) => [row.taskId, row.lastRead]));
  const claimedTasks = new Set(claimed.map((row) => row.taskId));
  const taskRefs = new Map(taskRows.map((task) => [task.id, task]));
  const bodies = new Map([
    ...commentRows.map((row) => [row.id, row.body] as const),
    ...messageRows.map((row) => [row.id, row.body] as const)
  ]);
  const agentNames = new Map(agentRows.map((row) => [row.id, row.name]));
  const userNames = new Map(userRows.map((row) => [row.id, row.name]));
  const actorOf = (event: EventRow): AttentionActor | null =>
    event.actorUserId
      ? {
          type: "human",
          id: event.actorUserId,
          name: userNames.get(event.actorUserId) ?? ""
        }
      : event.actorAgentId
        ? {
            type: "agent",
            id: event.actorAgentId,
            name: agentNames.get(event.actorAgentId) ?? ""
          }
        : null;
  const directed = (item: Candidate) =>
    item.kind === "direct_message" ||
    item.kind === "mention" ||
    item.kind === "handoff" ||
    item.kind === "blocker_resolved" ||
    ((item.kind === "task_comment" || item.kind === "status_changed") &&
      item.taskId !== undefined &&
      claimedTasks.has(item.taskId));

  const events: WaitEvent[] = [];
  let cursor = after;
  let stopped = false;
  for (const { event } of rows) {
    cursor = event.id;
    const item = candidates.get(event.id);
    if (!item) continue;
    if (item.requires === "watching") {
      const lastRead = watching.get(item.taskId!);
      // Comments at or below the read position were already seen (a mention
      // watch starts just below its comment), so they are not news.
      if (
        lastRead === undefined ||
        (item.commentSequence !== undefined && item.commentSequence <= lastRead)
      )
        continue;
    }
    if (
      item.requires === "own_block" &&
      blocks.get(item.blockId!)?.createdByAgentId !== agentId
    )
      continue;
    if (opts.directedOnly && !directed(item)) continue;
    if (opts.kinds && !opts.kinds.includes(item.kind)) continue;
    const body = bodies.get(item.commentId ?? item.messageId ?? "");
    events.push({
      kind: item.kind,
      event_id: event.id,
      occurred_at: event.occurredAt.toISOString(),
      actor: actorOf(event),
      task: item.taskId ? (taskRefs.get(item.taskId) ?? null) : null,
      ...(item.chatId ? { chat_id: item.chatId } : {}),
      ...(item.messageId ? { message_id: item.messageId } : {}),
      ...(item.commentSequence
        ? { comment_sequence: item.commentSequence }
        : {}),
      ...(item.handoffId ? { handoff_id: item.handoffId } : {}),
      ...(item.fromStatus ? { from_status: item.fromStatus } : {}),
      ...(item.toStatus ? { to_status: item.toStatus } : {}),
      ...(body !== undefined ? { excerpt: excerpt(body) } : {}),
      branch_id: null
    });
    if (events.length >= opts.limit) {
      stopped = true;
      break;
    }
  }
  return {
    events,
    cursor: String(cursor),
    more:
      (stopped && cursor !== rows.at(-1)?.event.id) ||
      rows.length === waitScanLimit
  };
}
