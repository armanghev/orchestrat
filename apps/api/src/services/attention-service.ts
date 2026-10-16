import {
  agents,
  chatMessages,
  chatParticipants,
  chats,
  handoffs,
  projectEvents,
  projects,
  taskBlocks,
  taskClaims,
  taskComments,
  taskWatches,
  tasks,
  users,
  type Database
} from "@orchestrat/db";
import type {
  AcknowledgeAttentionRequest,
  AcknowledgeAttentionResponse,
  AgentAttentionResponse,
  AttentionBlockerItem,
  AttentionHandoffItem,
  AttentionSummary,
  AttentionTaskItem,
  TaskAttentionOverlaysResponse,
  TaskBlock,
  TaskBlockResolution,
  TaskWatch,
  TaskWatchReason
} from "@orchestrat/protocol";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  ne,
  or,
  sql
} from "drizzle-orm";
import type { AgentPrincipal, Transaction } from "./agent-service.js";
import { ApiError } from "./api-error.js";
import { excerpt } from "./attention-guard.js";
import {
  findWatch,
  latestCommentSequence,
  watchActorClause,
  watchCount,
  watchLimitPerActor,
  type Actor
} from "./attention-hooks.js";
import { resolveBranch } from "./branch-context.js";
import type { ChatService } from "./chat-service.js";
import { PermissionService } from "./permission-service.js";

// Summary list caps. Notices trim further on the MCP side.
const listLimit = 50;
const unreadPerTask = 5;
// Unread excerpts come from the newest comments; the window bounds the rows
// fetched per task even when a task has thousands of unread comments.
const unreadWindow = 25;
const bodyPrefix = sql`2000`;

type Executor = Database | Transaction;
type TaskBlockRow = typeof taskBlocks.$inferSelect;
type WatchRow = typeof taskWatches.$inferSelect;
type UnreadChat = AttentionSummary["unread_chats"][number];

const notAuthoredBy = (actor: Actor) =>
  actor.type === "human"
    ? or(
        ne(taskComments.authorType, "human"),
        ne(taskComments.authorUserId, actor.id)
      )!
    : or(
        ne(taskComments.authorType, "agent"),
        ne(taskComments.authorAgentId, actor.id)
      )!;
const mentionsActor = (actor: Actor) =>
  sql`${taskComments.mentions} @> ${JSON.stringify([
    { type: actor.type, id: actor.id }
  ])}::jsonb`;
const participantClause = (actor: Actor) =>
  actor.type === "human"
    ? eq(chatParticipants.userId, actor.id)
    : eq(chatParticipants.agentId, actor.id);
const watchJson = (watch: WatchRow): TaskWatch => ({
  task_id: watch.taskId,
  state: watch.state as TaskWatch["state"],
  reason: watch.reason as TaskWatchReason,
  last_read_sequence: watch.lastReadSequence
});
const time = (value: Date | string | null) =>
  value === null ? 0 : new Date(value).getTime();

// Directed items in an agent summary: unread direct messages, chat and task
// mentions, unread comments above the claim baseline on claimed tasks, and
// unseen resolved blockers. A handoff is a direct message, so it is already
// counted through its chat.
const directedCount = (summary: AttentionSummary, directChats: Set<string>) =>
  summary.unread_chats.reduce(
    (total, chat) =>
      total +
      (directChats.has(chat.chat_id) ? chat.unread_count : chat.mention_count),
    0
  ) +
  summary.tasks.reduce(
    (total, task) =>
      total +
      (task.claimed_by_you
        ? Math.max(task.blocking_unread_count, task.mention_count)
        : task.mention_count),
    0
  ) +
  summary.blockers_resolved.length;

async function lockProject(tx: Transaction, projectId: string) {
  // Read positions and watches are private state, so archived projects still
  // accept them; the lock orders them with comment and claim writes.
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("update");
  if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
}

async function projectTask(tx: Executor, projectId: string, taskId: string) {
  const [task] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
    .limit(1);
  if (!task) throw new ApiError(404, "NOT_FOUND", "Task not found.");
}

// Hand-mapped block JSON with names resolved in three batched lookups.
export async function taskBlocksJson(
  executor: Executor,
  rows: TaskBlockRow[]
): Promise<TaskBlock[]> {
  if (rows.length === 0) return [];
  const taskIds = [...new Set(rows.flatMap((row) => row.blockingTaskId ?? []))];
  const userIds = [
    ...new Set(
      rows.flatMap((row) => [
        ...(row.createdByUserId ? [row.createdByUserId] : []),
        ...(row.blockedOnUserId ? [row.blockedOnUserId] : [])
      ])
    )
  ];
  const agentIds = [
    ...new Set(
      rows.flatMap((row) => [
        ...(row.createdByAgentId ? [row.createdByAgentId] : []),
        ...(row.blockedOnAgentId ? [row.blockedOnAgentId] : [])
      ])
    )
  ];
  const blockingTasks = new Map(
    (taskIds.length
      ? await executor
          .select({ id: tasks.id, key: tasks.taskKey, title: tasks.title })
          .from(tasks)
          .where(inArray(tasks.id, taskIds))
      : []
    ).map((task) => [task.id, task])
  );
  const userNames = new Map(
    (userIds.length
      ? await executor
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, userIds))
      : []
    ).map((user) => [user.id, user.name])
  );
  const agentNames = new Map(
    (agentIds.length
      ? await executor
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, agentIds))
      : []
    ).map((agent) => [agent.id, agent.name])
  );
  const actor = (userId: string | null, agentId: string | null) =>
    userId
      ? {
          type: "human" as const,
          id: userId,
          name: userNames.get(userId) ?? ""
        }
      : agentId
        ? {
            type: "agent" as const,
            id: agentId,
            name: agentNames.get(agentId) ?? ""
          }
        : null;
  return rows.map((row) => ({
    id: row.id,
    task_id: row.taskId,
    reason: row.reason,
    blocking_task: row.blockingTaskId
      ? (blockingTasks.get(row.blockingTaskId) ?? null)
      : null,
    blocked_on: actor(row.blockedOnUserId, row.blockedOnAgentId),
    created_by: actor(row.createdByUserId, row.createdByAgentId)!,
    created_at: row.createdAt.toISOString(),
    resolved_at: row.resolvedAt?.toISOString() ?? null,
    resolution: row.resolution as TaskBlockResolution | null
  }));
}

export class AttentionService {
  private readonly permissions: PermissionService;

  constructor(
    private readonly db: Database,
    private readonly chats: ChatService
  ) {
    this.permissions = new PermissionService(db);
  }

  // Branch scoping seam. Agents see the branch they work on: the one they name,
  // else their pinned session's, else the default branch. Humans pass null to
  // span all branches.
  attentionBranchScope(branchId?: string | null): string | null {
    return branchId ?? null;
  }

  async agentBranchId(
    principal: AgentPrincipal,
    requested?: string | null
  ): Promise<string> {
    const branch = await resolveBranch(
      this.db,
      principal.projectId,
      {
        branchId: requested ?? principal.branch?.branchId ?? null,
        sessionId: principal.branch?.sessionId ?? null
      },
      { agentId: principal.agentId }
    );
    return branch.id;
  }

  async currentCursor(projectId: string): Promise<string> {
    const [row] = await this.db
      .select({ value: max(projectEvents.id) })
      .from(projectEvents)
      .where(eq(projectEvents.projectId, projectId));
    return String(row?.value ?? 0);
  }

  async summaryAgent(
    principal: AgentPrincipal,
    opts: { branchId?: string | null } = {}
  ): Promise<AttentionSummary> {
    // The cursor is read first, so a wait resuming from it cannot miss an
    // event that landed while the summary was being assembled.
    const cursor = await this.currentCursor(principal.projectId);
    const branchId = await this.agentBranchId(principal, opts.branchId);
    const inbox = await this.chats.inboxAgent(principal, branchId);
    return this.summaryFor(
      { type: "agent", id: principal.agentId },
      principal.projectId,
      cursor,
      inbox.unread_chats,
      branchId
    );
  }

  async summaryHuman(
    userId: string,
    projectId: string
  ): Promise<AttentionSummary> {
    await this.permissions.projectAccess(userId, projectId);
    const cursor = await this.currentCursor(projectId);
    // Human attention spans every branch, like its task items.
    const inbox = await this.chats.inboxHuman(
      userId,
      projectId,
      undefined,
      true
    );
    return this.summaryFor(
      { type: "human", id: userId },
      projectId,
      cursor,
      inbox.unread_chats,
      null
    );
  }

  private async summaryFor(
    actor: Actor,
    projectId: string,
    cursor: string,
    unreadChats: UnreadChat[],
    branchId?: string | null
  ): Promise<AttentionSummary> {
    const scope = this.attentionBranchScope(branchId);
    const [taskPart, handoffPart, blockerPart] = await Promise.all([
      this.taskItems(actor, projectId, scope),
      this.handoffItems(actor, projectId, scope),
      this.blockerItems(actor, projectId, scope)
    ]);
    return {
      cursor,
      branch_id: scope,
      unread_chats: unreadChats,
      tasks: taskPart.items,
      handoffs: handoffPart.items,
      blockers_resolved: blockerPart.items,
      truncated:
        taskPart.truncated || handoffPart.truncated || blockerPart.truncated
    };
  }

  // One grouped query over the actor's watches joined to comments above the
  // read position. Muted watches only surface comments that mention the actor.
  private async unreadAggregates(
    actor: Actor,
    projectId: string,
    branchId: string | null
  ) {
    const rows = await this.db
      .select({
        taskId: taskWatches.taskId,
        state: taskWatches.state,
        lastRead: taskWatches.lastReadSequence,
        baseline: taskWatches.claimBaselineSequence,
        key: tasks.taskKey,
        title: tasks.title,
        status: tasks.status,
        unreadCount: count(taskComments.id),
        mentionCount:
          sql<number>`sum(case when ${mentionsActor(actor)} then 1 else 0 end)`.mapWith(
            Number
          ),
        blockingCount:
          sql<number>`sum(case when ${taskComments.sequence} > coalesce(${taskWatches.claimBaselineSequence}, 0) then 1 else 0 end)`.mapWith(
            Number
          ),
        latestAt: max(taskComments.createdAt)
      })
      .from(taskWatches)
      .innerJoin(
        tasks,
        and(
          eq(tasks.id, taskWatches.taskId),
          eq(tasks.projectId, projectId),
          branchId ? eq(tasks.branchId, branchId) : undefined
        )
      )
      .innerJoin(
        taskComments,
        and(
          eq(taskComments.taskId, taskWatches.taskId),
          gt(taskComments.sequence, taskWatches.lastReadSequence),
          notAuthoredBy(actor),
          // History copied by imports and merges never counts as unread.
          isNull(taskComments.importedAt)
        )
      )
      .where(and(eq(taskWatches.projectId, projectId), watchActorClause(actor)))
      .groupBy(
        taskWatches.id,
        taskWatches.taskId,
        taskWatches.state,
        taskWatches.lastReadSequence,
        taskWatches.claimBaselineSequence,
        tasks.id,
        tasks.taskKey,
        tasks.title,
        tasks.status
      );
    return rows
      .map((row) => {
        const watching = row.state === "watching";
        return {
          ...row,
          watching,
          unreadCount: watching ? Number(row.unreadCount) : row.mentionCount
        };
      })
      .filter((row) => row.unreadCount > 0);
  }

  private async taskItems(
    actor: Actor,
    projectId: string,
    branchId: string | null
  ) {
    const aggregates = await this.unreadAggregates(actor, projectId, branchId);
    const claimed = new Set(
      actor.type === "agent"
        ? (
            await this.db
              .select({ taskId: taskClaims.taskId })
              .from(taskClaims)
              .where(
                and(
                  eq(taskClaims.projectId, projectId),
                  eq(taskClaims.agentId, actor.id),
                  eq(taskClaims.status, "active")
                )
              )
          ).map((row) => row.taskId)
        : []
    );
    const ranked = aggregates
      .map((row) => ({ ...row, claimedByYou: claimed.has(row.taskId) }))
      .sort(
        (a, b) =>
          Number(b.claimedByYou) - Number(a.claimedByYou) ||
          b.mentionCount - a.mentionCount ||
          time(b.latestAt) - time(a.latestAt)
      );
    const page = ranked.slice(0, listLimit);
    if (page.length === 0) return { items: [], truncated: false };
    const ids = page.map((row) => row.taskId);
    const latest = new Map(
      (
        await this.db
          .select({
            taskId: taskComments.taskId,
            value: max(taskComments.sequence)
          })
          .from(taskComments)
          .where(inArray(taskComments.taskId, ids))
          .groupBy(taskComments.taskId)
      ).map((row) => [row.taskId, Number(row.value ?? 0)])
    );
    const windows = page.map((row) =>
      and(
        eq(taskComments.taskId, row.taskId),
        gt(
          taskComments.sequence,
          Math.max(row.lastRead, (latest.get(row.taskId) ?? 0) - unreadWindow)
        )
      )
    );
    const recent = await this.db
      .select({
        taskId: taskComments.taskId,
        sequence: taskComments.sequence,
        authorType: taskComments.authorType,
        authorUserId: taskComments.authorUserId,
        authorAgentId: taskComments.authorAgentId,
        authorName: taskComments.authorName,
        body: sql<string>`left(${taskComments.bodyMarkdown}, ${bodyPrefix})`,
        mentions: taskComments.mentions,
        createdAt: taskComments.createdAt
      })
      .from(taskComments)
      .where(and(or(...windows), notAuthoredBy(actor)))
      .orderBy(asc(taskComments.taskId), asc(taskComments.sequence));
    const items: AttentionTaskItem[] = page.map((row) => {
      const unread = recent
        .filter((comment) => comment.taskId === row.taskId)
        .map((comment) => ({
          ...comment,
          mentionsYou: comment.mentions.some(
            (mention) => mention.type === actor.type && mention.id === actor.id
          )
        }))
        .filter((comment) => row.watching || comment.mentionsYou)
        .slice(-unreadPerTask);
      return {
        task_id: row.taskId,
        key: row.key,
        title: row.title,
        status: row.status,
        watching: row.watching,
        claimed_by_you: row.claimedByYou,
        unread_count: row.unreadCount,
        mention_count: row.mentionCount,
        blocking_unread_count: row.claimedByYou ? row.blockingCount : 0,
        last_read_sequence: row.lastRead,
        latest_sequence: latest.get(row.taskId) ?? 0,
        unread: unread.map((comment) => ({
          sequence: comment.sequence,
          author: {
            type: comment.authorType,
            id: comment.authorUserId ?? comment.authorAgentId!,
            name: comment.authorName
          },
          excerpt: excerpt(comment.body),
          created_at: comment.createdAt.toISOString(),
          mentions_you: comment.mentionsYou
        }))
      };
    });
    return { items, truncated: ranked.length > listLimit };
  }

  // A handoff is pending while the recipient's chat read position is below
  // its message sequence; there is no second read state.
  private async handoffItems(
    actor: Actor,
    projectId: string,
    branchId: string | null
  ) {
    const rows = await this.db
      .select({
        handoff: handoffs,
        authorName: chatMessages.authorName,
        body: sql<string>`left(${chatMessages.bodyMarkdown}, ${bodyPrefix})`,
        taskKey: tasks.taskKey,
        taskTitle: tasks.title
      })
      .from(handoffs)
      .innerJoin(
        chatParticipants,
        and(
          eq(chatParticipants.chatId, handoffs.chatId),
          participantClause(actor),
          lt(chatParticipants.lastReadSequence, handoffs.messageSequence)
        )
      )
      .innerJoin(chatMessages, eq(chatMessages.id, handoffs.messageId))
      .leftJoin(tasks, eq(tasks.id, handoffs.taskId))
      .where(
        and(
          eq(handoffs.projectId, projectId),
          branchId ? eq(chatMessages.branchId, branchId) : undefined,
          actor.type === "agent"
            ? eq(handoffs.toAgentId, actor.id)
            : eq(handoffs.toUserId, actor.id)
        )
      )
      .orderBy(desc(handoffs.createdAt), desc(handoffs.id))
      .limit(listLimit + 1);
    const items: AttentionHandoffItem[] = rows
      .slice(0, listLimit)
      .map(({ handoff, authorName, body, taskKey, taskTitle }) => ({
        handoff_id: handoff.id,
        from: handoff.fromUserId
          ? { type: "human", id: handoff.fromUserId, name: authorName }
          : { type: "agent", id: handoff.fromAgentId!, name: authorName },
        chat_id: handoff.chatId,
        message_id: handoff.messageId,
        sequence: handoff.messageSequence,
        task:
          handoff.taskId && taskKey !== null && taskTitle !== null
            ? { id: handoff.taskId, key: taskKey, title: taskTitle }
            : null,
        excerpt: excerpt(body),
        created_at: handoff.createdAt.toISOString(),
        hop: handoff.hop
      }));
    return { items, truncated: rows.length > listLimit };
  }

  private async blockerItems(
    actor: Actor,
    projectId: string,
    branchId: string | null
  ) {
    // Task refs load separately: lookups by task_blocks.task_id hit the
    // one-open-per-task partial index, which pg-mem applies without its
    // predicate (resolved rows would vanish from the join).
    const rows = await this.db
      .select()
      .from(taskBlocks)
      .where(
        and(
          eq(taskBlocks.projectId, projectId),
          actor.type === "agent"
            ? eq(taskBlocks.createdByAgentId, actor.id)
            : eq(taskBlocks.createdByUserId, actor.id),
          isNotNull(taskBlocks.resolvedAt),
          isNull(taskBlocks.resolutionSeenAt)
        )
      )
      .orderBy(desc(taskBlocks.resolvedAt), desc(taskBlocks.id))
      .limit(listLimit + 1);
    const page = rows.slice(0, listLimit);
    const refs = new Map(
      (page.length
        ? await this.db
            .select({
              id: tasks.id,
              key: tasks.taskKey,
              title: tasks.title,
              branchId: tasks.branchId
            })
            .from(tasks)
            .where(
              inArray(
                tasks.id,
                page.map((block) => block.taskId)
              )
            )
        : []
      ).map((task) => [task.id, task])
    );
    const items: AttentionBlockerItem[] = page.flatMap((block) => {
      const ref = refs.get(block.taskId);
      if (!ref || (branchId && ref.branchId !== branchId)) return [];
      const task = { id: ref.id, key: ref.key, title: ref.title };
      return task
        ? [
            {
              block_id: block.id,
              task,
              resolution: block.resolution as TaskBlockResolution,
              resolved_at: block.resolvedAt!.toISOString()
            }
          ]
        : [];
    });
    return { items, truncated: rows.length > listLimit };
  }

  async acknowledgeAgent(
    principal: AgentPrincipal,
    input: AcknowledgeAttentionRequest
  ): Promise<AcknowledgeAttentionResponse> {
    const actor: Actor = { type: "agent", id: principal.agentId };
    return this.db.transaction(async (tx) => {
      await lockProject(tx, principal.projectId);
      for (const item of input.items) {
        if (item.type === "task_comments") {
          await this.markReadIn(
            tx,
            actor,
            principal.projectId,
            item.task_id,
            item.through_sequence
          );
        } else if (item.type === "handoff") {
          const [handoff] = await tx
            .select()
            .from(handoffs)
            .where(
              and(
                eq(handoffs.id, item.handoff_id),
                eq(handoffs.projectId, principal.projectId),
                eq(handoffs.toAgentId, principal.agentId)
              )
            )
            .limit(1);
          if (!handoff)
            throw new ApiError(404, "NOT_FOUND", "Handoff not found.");
          const [participant] = await tx
            .select()
            .from(chatParticipants)
            .where(
              and(
                eq(chatParticipants.chatId, handoff.chatId),
                participantClause(actor)
              )
            )
            .for("update");
          if (
            participant &&
            participant.lastReadSequence < handoff.messageSequence
          )
            await tx
              .update(chatParticipants)
              .set({ lastReadSequence: handoff.messageSequence })
              .where(eq(chatParticipants.id, participant.id));
        } else {
          const [block] = await tx
            .select()
            .from(taskBlocks)
            .where(
              and(
                eq(taskBlocks.id, item.block_id),
                eq(taskBlocks.projectId, principal.projectId),
                eq(taskBlocks.createdByAgentId, principal.agentId)
              )
            )
            .limit(1);
          if (!block) throw new ApiError(404, "NOT_FOUND", "Block not found.");
          if (!block.resolvedAt)
            throw new ApiError(
              409,
              "CONFLICT",
              "The blocker is not resolved yet."
            );
          if (!block.resolutionSeenAt)
            await tx
              .update(taskBlocks)
              .set({ resolutionSeenAt: new Date() })
              .where(eq(taskBlocks.id, block.id));
        }
      }
      return { acknowledged: input.items.length };
    });
  }

  // Advances a read position (never backwards). Reading a task the actor does
  // not watch yet starts an explicit watch, since the viewer engaged with it.
  private async markReadIn(
    tx: Transaction,
    actor: Actor,
    projectId: string,
    taskId: string,
    through: number
  ) {
    await projectTask(tx, projectId, taskId);
    const latest = await latestCommentSequence(tx, taskId);
    if (through > latest)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "through_sequence is beyond the task's latest comment.",
        { latest_sequence: latest }
      );
    const existing = await findWatch(tx, taskId, actor);
    if (existing) {
      if (through <= existing.lastReadSequence) return existing;
      const [updated] = await tx
        .update(taskWatches)
        .set({ lastReadSequence: through, updatedAt: new Date() })
        .where(eq(taskWatches.id, existing.id))
        .returning();
      return updated;
    }
    return this.insertExplicitWatch(tx, actor, projectId, taskId, {
      state: "watching",
      lastReadSequence: through
    });
  }

  private async insertExplicitWatch(
    tx: Transaction,
    actor: Actor,
    projectId: string,
    taskId: string,
    values: { state: "watching" | "muted"; lastReadSequence: number }
  ) {
    if ((await watchCount(tx, projectId, actor)) >= watchLimitPerActor)
      throw new ApiError(
        409,
        "WATCH_LIMIT",
        `You can watch at most ${watchLimitPerActor} tasks in a project.`
      );
    const [created] = await tx
      .insert(taskWatches)
      .values({
        projectId,
        taskId,
        userId: actor.type === "human" ? actor.id : null,
        agentId: actor.type === "agent" ? actor.id : null,
        state: values.state,
        reason: "explicit",
        lastReadSequence: values.lastReadSequence
      })
      .returning();
    return created;
  }

  private async watchAs(
    actor: Actor,
    projectId: string,
    taskId: string,
    watching: boolean
  ): Promise<TaskWatch> {
    return this.db.transaction(async (tx) => {
      await lockProject(tx, projectId);
      await projectTask(tx, projectId, taskId);
      const state = watching ? "watching" : "muted";
      const existing = await findWatch(tx, taskId, actor);
      if (existing) {
        const [updated] = await tx
          .update(taskWatches)
          .set({ state, reason: "explicit", updatedAt: new Date() })
          .where(eq(taskWatches.id, existing.id))
          .returning();
        return watchJson(updated);
      }
      // A new explicit watch starts at the current comment, not the history.
      return watchJson(
        await this.insertExplicitWatch(tx, actor, projectId, taskId, {
          state,
          lastReadSequence: await latestCommentSequence(tx, taskId)
        })
      );
    });
  }

  async watchAgent(
    principal: AgentPrincipal,
    taskId: string,
    watching: boolean
  ) {
    return this.watchAs(
      { type: "agent", id: principal.agentId },
      principal.projectId,
      taskId,
      watching
    );
  }

  private async humanTaskProject(userId: string, taskId: string) {
    const [task] = await this.db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!task) throw new ApiError(404, "NOT_FOUND", "Task not found.");
    await this.permissions.projectAccess(userId, task.projectId);
    return task.projectId;
  }

  async watchHuman(userId: string, taskId: string, watching: boolean) {
    const projectId = await this.humanTaskProject(userId, taskId);
    return this.watchAs(
      { type: "human", id: userId },
      projectId,
      taskId,
      watching
    );
  }

  async markReadHuman(
    userId: string,
    taskId: string,
    through: number
  ): Promise<TaskWatch> {
    const projectId = await this.humanTaskProject(userId, taskId);
    return this.db.transaction(async (tx) => {
      await lockProject(tx, projectId);
      return watchJson(
        await this.markReadIn(
          tx,
          { type: "human", id: userId },
          projectId,
          taskId,
          through
        )
      );
    });
  }

  async taskOverlaysHuman(
    userId: string,
    projectId: string
  ): Promise<TaskAttentionOverlaysResponse> {
    await this.permissions.projectAccess(userId, projectId);
    const actor: Actor = { type: "human", id: userId };
    const [watches, unread, claims, openBlocks] = await Promise.all([
      this.db
        .select({ taskId: taskWatches.taskId, state: taskWatches.state })
        .from(taskWatches)
        .where(
          and(eq(taskWatches.projectId, projectId), watchActorClause(actor))
        ),
      // Overlays are keyed by task id, so spanning every branch is harmless.
      this.unreadAggregates(actor, projectId, null),
      this.db
        .select({ claim: taskClaims, agentName: agents.name })
        .from(taskClaims)
        .innerJoin(agents, eq(agents.id, taskClaims.agentId))
        .where(
          and(
            eq(taskClaims.projectId, projectId),
            eq(taskClaims.status, "active")
          )
        ),
      this.db
        .select()
        .from(taskBlocks)
        .where(
          and(
            eq(taskBlocks.projectId, projectId),
            isNull(taskBlocks.resolvedAt)
          )
        )
    ]);
    const watchByTask = new Map(watches.map((row) => [row.taskId, row.state]));
    const unreadByTask = new Map(unread.map((row) => [row.taskId, row]));
    const claimByTask = new Map(claims.map((row) => [row.claim.taskId, row]));
    const blocks = await taskBlocksJson(this.db, openBlocks);
    const blockByTask = new Map(blocks.map((block) => [block.task_id, block]));
    const taskIds = [
      ...new Set([
        ...watchByTask.keys(),
        ...claimByTask.keys(),
        ...blockByTask.keys()
      ])
    ].sort();
    return {
      tasks: taskIds.map((taskId) => {
        const counts = unreadByTask.get(taskId);
        const claim = claimByTask.get(taskId);
        return {
          task_id: taskId,
          watching: watchByTask.get(taskId) === "watching",
          unread_count: counts?.unreadCount ?? 0,
          mention_count: counts?.mentionCount ?? 0,
          claim: claim
            ? {
                agent_id: claim.claim.agentId,
                agent_name: claim.agentName,
                status: claim.claim.status,
                lease_expires_at: claim.claim.leaseExpiresAt.toISOString()
              }
            : null,
          block: blockByTask.get(taskId) ?? null
        };
      })
    };
  }

  private async directChats(chatIds: string[]) {
    const ids = [...new Set(chatIds)];
    return new Set(
      (ids.length
        ? await this.db
            .select({ id: chats.id })
            .from(chats)
            .where(and(inArray(chats.id, ids), eq(chats.kind, "direct")))
        : []
      ).map((chat) => chat.id)
    );
  }

  // True when an agent summary holds directed items, which makes a wait
  // without a cursor return `pending` at once.
  async hasDirectedPending(summary: AttentionSummary): Promise<boolean> {
    if (summary.handoffs.length > 0 || summary.blockers_resolved.length > 0)
      return true;
    const directChats = await this.directChats(
      summary.unread_chats.map((chat) => chat.chat_id)
    );
    return directedCount(summary, directChats) > 0;
  }

  // Per-agent status line for the dashboard. pending_directed_count uses the
  // same directed rule that makes a wait return `pending`.
  async agentAttentionHuman(
    userId: string,
    projectId: string,
    waitingSince: Map<string, Date>
  ): Promise<AgentAttentionResponse> {
    await this.permissions.projectAccess(userId, projectId);
    const [activeAgents, openBlocks, currentClaims] = await Promise.all([
      this.db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(eq(agents.projectId, projectId), eq(agents.status, "active"))
        )
        .orderBy(asc(agents.name), asc(agents.id)),
      this.db
        .select({
          agentId: taskBlocks.createdByAgentId,
          reason: taskBlocks.reason,
          taskId: tasks.id,
          key: tasks.taskKey,
          title: tasks.title
        })
        .from(taskBlocks)
        .innerJoin(tasks, eq(tasks.id, taskBlocks.taskId))
        .where(
          and(
            eq(taskBlocks.projectId, projectId),
            isNull(taskBlocks.resolvedAt),
            isNotNull(taskBlocks.createdByAgentId)
          )
        )
        .orderBy(desc(taskBlocks.createdAt)),
      this.db
        .select({
          agentId: taskClaims.agentId,
          id: tasks.id,
          key: tasks.taskKey,
          title: tasks.title,
          status: tasks.status
        })
        .from(taskClaims)
        .innerJoin(tasks, eq(tasks.id, taskClaims.taskId))
        .where(
          and(
            eq(taskClaims.projectId, projectId),
            eq(taskClaims.status, "active")
          )
        )
        .orderBy(desc(taskClaims.claimedAt))
    ]);
    const summaries = [];
    for (const agent of activeAgents) {
      const inbox = await this.chats.inboxAgent(
        { agentId: agent.id, projectId, credentialId: "" },
        null
      );
      summaries.push({
        agentId: agent.id,
        summary: await this.summaryFor(
          { type: "agent", id: agent.id },
          projectId,
          "0",
          inbox.unread_chats
        )
      });
    }
    const directChats = await this.directChats(
      summaries.flatMap(({ summary }) =>
        summary.unread_chats.map((chat) => chat.chat_id)
      )
    );
    return {
      agents: summaries.map(({ agentId, summary }) => {
        const block = openBlocks.find((row) => row.agentId === agentId);
        const current = currentClaims.find((row) => row.agentId === agentId);
        return {
          agent_id: agentId,
          waiting_since: waitingSince.get(agentId)?.toISOString() ?? null,
          pending_directed_count: directedCount(summary, directChats),
          open_block: block
            ? {
                task: { id: block.taskId, key: block.key, title: block.title },
                reason: block.reason
              }
            : null,
          current_task: current
            ? {
                id: current.id,
                key: current.key,
                title: current.title,
                status: current.status
              }
            : null
        };
      })
    };
  }
}
