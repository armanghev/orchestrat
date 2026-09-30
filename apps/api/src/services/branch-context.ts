import { and, eq } from "drizzle-orm";
import { projectBranches, type Database } from "@orchestrat/db";
import { ApiError } from "./api-error.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Transaction;

/** Name of a default branch before Git names it (docs/project-branches.md §8.7). */
export const FALLBACK_DEFAULT_BRANCH_NAME = "main";

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
  const existing = await findDefaultBranchId(tx, projectId);
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
  const repaired = await findDefaultBranchId(tx, projectId);
  if (!repaired) throw new ApiError(404, "NOT_FOUND", "Project not found.");
  return repaired;
}

async function findDefaultBranchId(tx: Executor, projectId: string) {
  const [branch] = await tx
    .select({ id: projectBranches.id })
    .from(projectBranches)
    .where(
      and(
        eq(projectBranches.projectId, projectId),
        eq(projectBranches.isDefault, true)
      )
    )
    .limit(1);
  return branch?.id ?? null;
}
