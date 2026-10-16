import {
  agents,
  organizationMembers,
  projectMembers,
  projects,
  taskBlocks,
  taskComments,
  taskWatches,
  users
} from "@orchestrat/db";
import { and, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { ApiError } from "./api-error.js";
import type { Transaction } from "./agent-service.js";

// Transaction-scoped attention hooks. Existing services call these inside their
// own write transactions, after the project row lock.
export type Actor = { type: "human" | "agent"; id: string };
export type CommentMention = {
  type: "human" | "agent";
  id: string;
  name: string;
};
export type WatchReason =
  "created" | "claimed" | "commented" | "mentioned" | "handoff" | "explicit";

export const watchLimitPerActor = 1000;
export const mentionLimit = 20;

const keyFor = (value: { type: string; id: string }) =>
  `${value.type}:${value.id}`;

export const watchActorClause = (actor: Actor) =>
  actor.type === "human"
    ? and(eq(taskWatches.userId, actor.id), isNull(taskWatches.agentId))!
    : and(eq(taskWatches.agentId, actor.id), isNull(taskWatches.userId))!;

export async function latestCommentSequence(tx: Transaction, taskId: string) {
  const [row] = await tx
    .select({
      value: sql<number>`coalesce(max(${taskComments.sequence}), 0)`.mapWith(
        Number
      )
    })
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId));
  return row?.value ?? 0;
}

// Callers hold the task row lock, so max + 1 is gap-free and unique per task.
export async function nextCommentSequence(tx: Transaction, taskId: string) {
  return (await latestCommentSequence(tx, taskId)) + 1;
}

export async function resolveCommentMentions(
  tx: Transaction,
  projectId: string,
  refs: { type: "human" | "agent"; id: string }[] = []
): Promise<CommentMention[]> {
  const unique = [...new Map(refs.map((ref) => [keyFor(ref), ref])).values()];
  if (unique.length === 0) return [];
  if (unique.length > mentionLimit)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `A comment can mention at most ${mentionLimit} participants.`
    );
  const humanIds = unique
    .filter((ref) => ref.type === "human")
    .map((ref) => ref.id);
  const agentIds = unique
    .filter((ref) => ref.type === "agent")
    .map((ref) => ref.id);
  // Message candidates: project members still in the organization, plus
  // active agents. Revoked agents and other projects' actors are rejected.
  const humans = humanIds.length
    ? await tx
        .select({ id: users.id, name: users.name })
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
            inArray(projectMembers.userId, humanIds)
          )
        )
    : [];
  const agentRows = agentIds.length
    ? await tx
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          and(
            eq(agents.projectId, projectId),
            eq(agents.status, "active"),
            inArray(agents.id, agentIds)
          )
        )
    : [];
  const names = new Map<string, string>([
    ...humans.map((row): [string, string] => [`human:${row.id}`, row.name]),
    ...agentRows.map((row): [string, string] => [`agent:${row.id}`, row.name])
  ]);
  if (names.size !== unique.length)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Mentions must name members or active agents of this project."
    );
  return unique.map((ref) => ({
    type: ref.type,
    id: ref.id,
    name: names.get(keyFor(ref))!
  }));
}

export async function findWatch(tx: Transaction, taskId: string, actor: Actor) {
  const [watch] = await tx
    .select()
    .from(taskWatches)
    .where(and(eq(taskWatches.taskId, taskId), watchActorClause(actor)))
    .limit(1);
  return watch ?? null;
}

export async function watchCount(
  tx: Transaction,
  projectId: string,
  actor: Actor
) {
  const [row] = await tx
    .select({ value: count() })
    .from(taskWatches)
    .where(and(eq(taskWatches.projectId, projectId), watchActorClause(actor)));
  return Number(row?.value ?? 0);
}

// Inserts a watch if missing. Never changes an existing row, so a mute stays
// sticky. Automatic watches stop past the per-actor limit; a claim always gets
// its row because the completion guard reads the claim baseline from it.
export async function ensureWatch(
  tx: Transaction,
  input: {
    projectId: string;
    taskId: string;
    actor: Actor;
    reason: WatchReason;
    lastReadSequence?: number;
  }
) {
  const existing = await findWatch(tx, input.taskId, input.actor);
  if (existing) return existing;
  if (
    input.reason !== "claimed" &&
    (await watchCount(tx, input.projectId, input.actor)) >= watchLimitPerActor
  )
    return null;
  const [created] = await tx
    .insert(taskWatches)
    .values({
      projectId: input.projectId,
      taskId: input.taskId,
      userId: input.actor.type === "human" ? input.actor.id : null,
      agentId: input.actor.type === "agent" ? input.actor.id : null,
      reason: input.reason,
      lastReadSequence: Math.max(0, input.lastReadSequence ?? 0)
    })
    .onConflictDoNothing()
    .returning();
  return created ?? (await findWatch(tx, input.taskId, input.actor));
}

export async function onTaskCreated(
  tx: Transaction,
  input: { projectId: string; taskId: string; actor: Actor }
) {
  await ensureWatch(tx, { ...input, reason: "created" });
}

export async function onTaskClaimed(
  tx: Transaction,
  input: { projectId: string; taskId: string; agentId: string }
) {
  const actor: Actor = { type: "agent", id: input.agentId };
  const baseline = await latestCommentSequence(tx, input.taskId);
  const watch = await ensureWatch(tx, {
    projectId: input.projectId,
    taskId: input.taskId,
    actor,
    reason: "claimed"
  });
  if (watch)
    await tx
      .update(taskWatches)
      .set({ claimBaselineSequence: baseline, updatedAt: new Date() })
      .where(eq(taskWatches.id, watch.id));
  // Claiming again counts as having seen this agent's resolved blockers. The
  // task filter runs in JS: pg-mem applies the one-open-per-task partial
  // index on task_id without its predicate, hiding resolved rows.
  const unseen = await tx
    .select({ id: taskBlocks.id, taskId: taskBlocks.taskId })
    .from(taskBlocks)
    .where(
      and(
        eq(taskBlocks.projectId, input.projectId),
        eq(taskBlocks.createdByAgentId, input.agentId),
        isNotNull(taskBlocks.resolvedAt),
        isNull(taskBlocks.resolutionSeenAt)
      )
    );
  const seen = unseen
    .filter((block) => block.taskId === input.taskId)
    .map((block) => block.id);
  if (seen.length)
    await tx
      .update(taskBlocks)
      .set({ resolutionSeenAt: new Date() })
      .where(inArray(taskBlocks.id, seen));
}

export async function onTaskCommentCreated(
  tx: Transaction,
  input: {
    projectId: string;
    taskId: string;
    sequence: number;
    actor: Actor;
    mentions: { type: "human" | "agent"; id: string }[];
  }
) {
  // Posting never advances the author's read position.
  await ensureWatch(tx, {
    projectId: input.projectId,
    taskId: input.taskId,
    actor: input.actor,
    reason: "commented"
  });
  for (const mention of input.mentions) {
    if (keyFor(mention) === keyFor(input.actor)) continue;
    await ensureWatch(tx, {
      projectId: input.projectId,
      taskId: input.taskId,
      actor: { type: mention.type, id: mention.id },
      reason: "mentioned",
      lastReadSequence: input.sequence - 1
    });
  }
}
