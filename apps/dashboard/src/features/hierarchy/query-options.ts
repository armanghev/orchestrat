import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "@/lib/api/client";
import { loadProjectCatalog } from "./catalog";

const hierarchyStaleTime = 2 * 60 * 1000;

export const hierarchyKeys = {
  all: ["hierarchy"] as const,
  organizations: () => [...hierarchyKeys.all, "organizations"] as const,
  projects: (organizationId: string) =>
    [
      ...hierarchyKeys.all,
      "organizations",
      organizationId,
      "projects"
    ] as const,
  members: (organizationId: string) =>
    [...hierarchyKeys.all, "organizations", organizationId, "members"] as const,
  projectSummaries: (organizationId: string) =>
    [
      ...hierarchyKeys.all,
      "organizations",
      organizationId,
      "project-summaries"
    ] as const,
  catalog: () => [...hierarchyKeys.all, "catalog"] as const
};

export function organizationsQueryOptions(api: ApiClient) {
  return queryOptions({
    queryKey: hierarchyKeys.organizations(),
    queryFn: () => api.listOrganizations(),
    staleTime: hierarchyStaleTime
  });
}

export function projectsQueryOptions(api: ApiClient, organizationId: string) {
  return queryOptions({
    queryKey: hierarchyKeys.projects(organizationId),
    queryFn: () => api.listProjects(organizationId),
    staleTime: hierarchyStaleTime
  });
}

export function organizationMembersQueryOptions(
  api: ApiClient,
  organizationId: string
) {
  return queryOptions({
    queryKey: hierarchyKeys.members(organizationId),
    queryFn: () => api.listOrganizationMembers(organizationId),
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

export function projectSummariesQueryOptions(
  api: ApiClient,
  organizationId: string
) {
  return queryOptions({
    queryKey: hierarchyKeys.projectSummaries(organizationId),
    queryFn: () => api.listProjectSummaries(organizationId),
    staleTime: hierarchyStaleTime
  });
}
