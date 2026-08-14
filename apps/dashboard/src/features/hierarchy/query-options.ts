import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "@/lib/api/client";
import { loadProjectCatalog } from "./catalog";

const hierarchyStaleTime = 2 * 60 * 1000;

export const hierarchyKeys = {
  all: ["hierarchy"] as const,
  organizations: () => [...hierarchyKeys.all, "organizations"] as const,
  workspaces: (organizationId: string) =>
    [...hierarchyKeys.all, "organizations", organizationId, "workspaces"] as const,
  projects: (workspaceId: string) =>
    [...hierarchyKeys.all, "workspaces", workspaceId, "projects"] as const,
  catalog: () => [...hierarchyKeys.all, "catalog"] as const
};

export function organizationsQueryOptions(api: ApiClient) {
  return queryOptions({
    queryKey: hierarchyKeys.organizations(),
    queryFn: () => api.listOrganizations(),
    staleTime: hierarchyStaleTime
  });
}

export function workspacesQueryOptions(api: ApiClient, organizationId: string) {
  return queryOptions({
    queryKey: hierarchyKeys.workspaces(organizationId),
    queryFn: () => api.listWorkspaces(organizationId),
    staleTime: hierarchyStaleTime
  });
}

export function projectsQueryOptions(api: ApiClient, workspaceId: string) {
  return queryOptions({
    queryKey: hierarchyKeys.projects(workspaceId),
    queryFn: () => api.listProjects(workspaceId),
    staleTime: hierarchyStaleTime
  });
}

export function projectCatalogQueryOptions(api: ApiClient) {
  return queryOptions({
    queryKey: hierarchyKeys.catalog(),
    queryFn: ({ client }) => loadProjectCatalog(client, api),
    staleTime: hierarchyStaleTime
  });
}
