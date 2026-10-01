import { queryOptions } from "@tanstack/react-query";
import type { Branch } from "@orchestrat/protocol";
import type { ApiClient } from "@/lib/api/client";

// Branches change rarely and every branch.* event refetches the list
// (docs/project-branches.md §11.1), so a short stale time is enough.
const branchesStaleTime = 30_000;

export const branchKeys = {
  all: ["branches"] as const,
  project: (projectId: string) => [...branchKeys.all, projectId] as const,
  list: (projectId: string) =>
    [...branchKeys.project(projectId), "list"] as const
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
