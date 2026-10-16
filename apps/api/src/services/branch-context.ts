import { and, eq } from "drizzle-orm";
import { agentSessions, projectBranches, type Database } from "@orchestrat/db";
import { branchSelectorQuerySchema } from "@orchestrat/protocol";
import { ApiError } from "./api-error.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Transaction;
export type BranchRow = typeof projectBranches.$inferSelect;

/** Name of a default branch before Git names it. */
export const FALLBACK_DEFAULT_BRANCH_NAME = "main";

/**
 * What a request said about its branch. Humans set `branchId` from
 * `?branch_id=`; agents set it from `X-Orchestrat-Branch-Id` and may pin a
 * session with `X-Orchestrat-Session-Id`. Absent everywhere = default branch.
 */
export type BranchSelector = {
  branchId?: string | null;
  sessionId?: string | null;
};

/** Old clients never send a branch signal, so they must never see a new code. */
const isExplicit = (selector: BranchSelector | undefined) =>
  Boolean(selector?.branchId || selector?.sessionId);

/**
 * The project's default branch id. Migration 0016 creates one per project and
 * new projects get one in the same transaction; a project the pre-branches
 * API created while the hosted database was already migrated has none, so
 * this repairs it lazily. Concurrent repairs are safe: the partial unique
 * index project_branches_one_default lets exactly one insert win.
 */
export async function defaultBranchId(
  tx: Executor,
  projectId: string
): Promise<string> {
  return (await defaultBranch(tx, projectId)).id;
}

export async function defaultBranch(
  tx: Executor,
  projectId: string
): Promise<BranchRow> {
  const existing = await findDefaultBranch(tx, projectId);
  if (existing) return existing;
  await tx
    .insert(projectBranches)
    .values({
      projectId,
      name: FALLBACK_DEFAULT_BRANCH_NAME,
      isDefault: true,
      nameSource: "fallback",
      createdVia: "migration",
      onboardingState: "completed",
      onboardingCompletedAt: new Date()
    })
    .onConflictDoNothing();
  const repaired = await findDefaultBranch(tx, projectId);
  if (!repaired) throw new ApiError(404, "NOT_FOUND", "Project not found.");
  return repaired;
}

async function findDefaultBranch(tx: Executor, projectId: string) {
  const [branch] = await tx
    .select()
    .from(projectBranches)
    .where(
      and(
        eq(projectBranches.projectId, projectId),
        eq(projectBranches.isDefault, true)
      )
    )
    .limit(1);
  return branch ?? null;
}

export async function findProjectBranch(
  tx: Executor,
  projectId: string,
  branchId: string
) {
  const [branch] = await tx
    .select()
    .from(projectBranches)
    .where(
      and(
        eq(projectBranches.projectId, projectId),
        eq(projectBranches.id, branchId)
      )
    )
    .limit(1);
  return branch ?? null;
}

/**
 * Resolves the branch a collection or create request acts on: a pinned session
 * wins, and an explicit branch that disagrees with it is a 409; otherwise the
 * explicit branch; otherwise the default branch. Writes to an archived branch
 * are refused.
 */
export async function resolveBranch(
  tx: Executor,
  projectId: string,
  selector: BranchSelector | undefined,
  options: { write?: boolean; agentId?: string } = {}
): Promise<BranchRow> {
  let branchId = selector?.branchId ?? null;
  if (selector?.sessionId) {
    const [session] = await tx
      .select({
        branchId: agentSessions.branchId,
        agentId: agentSessions.agentId
      })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.projectId, projectId),
          eq(agentSessions.id, selector.sessionId)
        )
      )
      .limit(1);
    if (!session || (options.agentId && session.agentId !== options.agentId))
      throw new ApiError(
        404,
        "AGENT_SESSION_NOT_FOUND",
        "Agent session not found."
      );
    if (branchId && branchId !== session.branchId)
      throw new ApiError(
        409,
        "BRANCH_MISMATCH",
        "The requested branch differs from the session's pinned branch.",
        { session_branch_id: session.branchId, requested_branch_id: branchId }
      );
    branchId = session.branchId;
  }
  const branch = branchId
    ? await findProjectBranch(tx, projectId, branchId)
    : await defaultBranch(tx, projectId);
  if (!branch)
    throw new ApiError(404, "BRANCH_NOT_FOUND", "Branch not found.", {
      branch_id: branchId
    });
  if (options.write) assertBranchWritable(branch, selector);
  return branch;
}

/** Archived branches are read-only. */
export function assertBranchWritable(
  branch: Pick<BranchRow, "id" | "archivedAt">,
  selector?: BranchSelector
) {
  if (!branch.archivedAt) return;
  if (isExplicit(selector))
    throw new ApiError(409, "BRANCH_ARCHIVED", "This branch is archived.", {
      branch_id: branch.id
    });
  throw new ApiError(409, "CONFLICT", "This branch is archived.", {
    reason: "branch_archived",
    branch_id: branch.id
  });
}

/**
 * Entity routes take the branch from the row. A human who names a different
 * branch gets a 404, like a wrong project today. Agents may read entities on
 * any branch of their project, but a write must match the branch they named or
 * the one their session is pinned to.
 */
export async function assertEntityBranch(
  tx: Executor,
  projectId: string,
  entityBranchId: string,
  selector: BranchSelector | undefined,
  options: {
    actor: "human" | "agent";
    write?: boolean;
    agentId?: string;
    notFound?: string;
  }
): Promise<BranchRow> {
  if (
    options.actor === "human" &&
    selector?.branchId &&
    selector.branchId !== entityBranchId
  )
    throw new ApiError(404, "NOT_FOUND", options.notFound ?? "Not found.");
  if (
    options.actor === "agent" &&
    options.write &&
    (selector?.branchId || selector?.sessionId)
  ) {
    const working = await resolveBranch(tx, projectId, selector, {
      agentId: options.agentId
    });
    if (working.id !== entityBranchId)
      throw new ApiError(
        409,
        "BRANCH_MISMATCH",
        "This item is on a different branch than the one you are working on.",
        { branch_id: working.id, entity_branch_id: entityBranchId }
      );
  }
  const branch = await findProjectBranch(tx, projectId, entityBranchId);
  if (!branch)
    throw new ApiError(404, "NOT_FOUND", options.notFound ?? "Not found.");
  if (options.write) assertBranchWritable(branch, selector);
  return branch;
}

/** `?branch_id=` on human collection routes; absent = the default branch. */
export function humanBranchSelector(query: unknown): BranchSelector {
  return { branchId: branchSelectorQuerySchema.parse(query).branch_id ?? null };
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Parses the agent branch headers; a malformed value is a 400 (explicit). */
export function agentBranchSelector(headers: {
  [key: string]: string | string[] | undefined;
}): BranchSelector {
  const read = (name: string) => {
    const value = headers[name];
    if (value === undefined) return null;
    const text = Array.isArray(value) ? value[0] : value;
    if (!text || !uuidPattern.test(text.trim()))
      throw new ApiError(400, "VALIDATION_ERROR", `${name} must be a UUID.`, {
        header: name
      });
    return text.trim().toLowerCase();
  };
  return {
    branchId: read("x-orchestrat-branch-id"),
    sessionId: read("x-orchestrat-session-id")
  };
}
