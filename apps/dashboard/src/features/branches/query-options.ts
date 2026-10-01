import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { Branch } from "@orchestrat/protocol";
import type { ApiClient } from "@/lib/api/client";

// Branches change rarely and every branch.* event refetches the list
// (docs/project-branches.md §11.1), so a short stale time is enough.
const branchesStaleTime = 30_000;

// Merges, decisions and previews live under the project key, so one
// invalidation after a merge refreshes all of them.
export const branchKeys = {
  all: ["branches"] as const,
  project: (projectId: string) => [...branchKeys.all, projectId] as const,
  list: (projectId: string) =>
    [...branchKeys.project(projectId), "list"] as const,
  merges: (projectId: string) =>
    [...branchKeys.project(projectId), "merges"] as const,
  /** Open decisions targeting a branch, or every branch's. */
  decisions: (projectId: string, branchId: string | "all") =>
    [...branchKeys.project(projectId), "decisions", branchId] as const,
  preview: (
    projectId: string,
    kind: "import" | "merge",
    sourceId: string,
    targetId: string
  ) =>
    [
      ...branchKeys.project(projectId),
      "preview",
      kind,
      sourceId,
      targetId
    ] as const
};

/** Every branch of a project, archived ones included: active first, the
 * default first among them, then the most recently updated. */
export const branchesQueryOptions = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: branchKeys.list(projectId),
    queryFn: () => api.listBranches(projectId, { include_archived: true }),
    staleTime: branchesStaleTime
  });

export function defaultBranchOf(branches: Branch[]) {
  return branches.find((branch) => branch.is_default) ?? null;
}

/** The branch a URL names, or the default when it names none. Null when the
 * URL names a branch this project doesn't have. */
export function resolveBranch(branches: Branch[], requested?: string) {
  if (!requested) return defaultBranchOf(branches);
  return branches.find((branch) => branch.id === requested) ?? null;
}

/** Merge history, newest first, a page at a time. */
export const mergeRunsQueryOptions = (api: ApiClient, projectId: string) =>
  infiniteQueryOptions({
    queryKey: branchKeys.merges(projectId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.listMergeRuns(projectId, { limit: 25, cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined
  });

export const decisionsQueryOptions = (
  api: ApiClient,
  projectId: string,
  branchId: string | "all"
) =>
  queryOptions({
    queryKey: branchKeys.decisions(projectId, branchId),
    queryFn: () =>
      api.listDecisions(projectId, {
        status: "open",
        ...(branchId === "all" ? {} : { branch_id: branchId })
      })
  });
