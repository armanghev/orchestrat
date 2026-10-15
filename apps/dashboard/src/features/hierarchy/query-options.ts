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

export const integrationKeys = {
  all: (organizationId: string) =>
    [
      ...hierarchyKeys.all,
      "organizations",
      organizationId,
      "integrations"
    ] as const,
  repositories: (organizationId: string, filter: "importable" | "all") =>
    [
      ...hierarchyKeys.all,
      "organizations",
      organizationId,
      "repositories",
      filter
    ] as const
};

/** The organization's Git integrations (owners and admins). */
export function organizationIntegrationsQueryOptions(
  api: ApiClient,
  organizationId: string
) {
  return queryOptions({
    queryKey: integrationKeys.all(organizationId),
    queryFn: () => api.listOrganizationIntegrations(organizationId),
    staleTime: 60_000
  });
}

/** Repositories the organization's integrations reach. */
export function organizationRepositoriesQueryOptions(
  api: ApiClient,
  organizationId: string,
  filter: "importable" | "all" = "importable"
) {
  return queryOptions({
    queryKey: integrationKeys.repositories(organizationId, filter),
    queryFn: () => api.listOrganizationRepositories(organizationId, filter),
    staleTime: 60_000
  });
}
