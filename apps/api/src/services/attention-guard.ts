import { taskComments, taskWatches } from "@orchestrat/db";
import {
  and,
  count,
  desc,
  eq,
  gt,
  isNull,
  max,
  ne,
  or,
  sql
} from "drizzle-orm";
import { ApiError } from "./api-error.js";
import type { Transaction } from "./agent-service.js";
import {
  ensureWatch,
  findWatch,
  latestCommentSequence
} from "./attention-hooks.js";

export const excerptLength = 280;
export const excerpt = (body: string) => {
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length > excerptLength
    ? `${collapsed.slice(0, excerptLength - 1)}…`
    : collapsed;
};

export const notAuthoredByAgent = (agentId: string) =>
  or(
    ne(taskComments.authorType, "agent"),
    ne(taskComments.authorAgentId, agentId)
  )!;

// Safe completion. Runs inside the claim-ending transaction, after the project
// and task row locks, so a concurrent comment either committed before this read
// (and blocks) or commits after the claim ends.
export async function assertCommentsAcknowledged(
  tx: Transaction,
  input: {
    projectId: string;
    taskId: string;
    agentId: string;
    acknowledgedThrough?: number;
  }
) {
  const actor = { type: "agent" as const, id: input.agentId };
  const watch = await findWatch(tx, input.taskId, actor);
  const floor = Math.max(
    watch?.lastReadSequence ?? 0,
    watch?.claimBaselineSequence ?? 0
  );
  const unreadClause = and(
    eq(taskComments.taskId, input.taskId),
    gt(taskComments.sequence, floor),
    notAuthoredByAgent(input.agentId),
    // History copied by imports and merges is never "posted since the claim".
    isNull(taskComments.importedAt)
  );
  const [unread] = await tx
    .select({ total: count(), latest: max(taskComments.sequence) })
    .from(taskComments)
    .where(unreadClause);
  const totalUnread = Number(unread?.total ?? 0);
  const latestUnread = Number(unread?.latest ?? 0);
  const acknowledged = input.acknowledgedThrough;
  if (
    totalUnread > 0 &&
    (acknowledged === undefined || acknowledged < latestUnread)
  ) {
    const latestSequence = await latestCommentSequence(tx, input.taskId);
    const rows = await tx
      .select({
        sequence: taskComments.sequence,
        authorType: taskComments.authorType,
        authorUserId: taskComments.authorUserId,
        authorAgentId: taskComments.authorAgentId,
        authorName: taskComments.authorName,
        body: sql<string>`left(${taskComments.bodyMarkdown}, 2000)`,
        createdAt: taskComments.createdAt
      })
      .from(taskComments)
      .where(unreadClause)
      .orderBy(desc(taskComments.sequence))
      .limit(10);
    throw new ApiError(
      409,
      "TASK_COMMENTS_UNREAD",
      "Read the new task comments before ending the claim, then pass acknowledged_through.",
      {
        task_id: input.taskId,
        latest_sequence: latestSequence,
        total_unread: totalUnread,
        unread: rows.reverse().map((row) => ({
          sequence: row.sequence,
          author: {
            type: row.authorType,
            id: row.authorUserId ?? row.authorAgentId!,
            name: row.authorName
          },
          excerpt: excerpt(row.body),
          created_at: row.createdAt.toISOString()
        }))
      }
    );
  }
  if (acknowledged === undefined) return;
  const latestSequence = await latestCommentSequence(tx, input.taskId);
  if (acknowledged > latestSequence)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "acknowledged_through is beyond the task's latest comment.",
      { latest_sequence: latestSequence }
    );
  const current =
    watch ??
    (await ensureWatch(tx, {
      projectId: input.projectId,
      taskId: input.taskId,
      actor,
      reason: "claimed"
    }));
  if (current && acknowledged > current.lastReadSequence)
    await tx
      .update(taskWatches)
      .set({ lastReadSequence: acknowledged, updatedAt: new Date() })
      .where(eq(taskWatches.id, current.id));
}
