import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "@/lib/api/client";

export const repositoryKeys = {
  all: ["repository"] as const,
  project: (projectId: string) => [...repositoryKeys.all, projectId] as const,
  deliveries: (projectId: string) =>
    [...repositoryKeys.project(projectId), "deliveries"] as const,
  candidates: (projectId: string, authorizationId: string) =>
    [
      ...repositoryKeys.project(projectId),
      "candidates",
      authorizationId
    ] as const
};

/** The project's connection, if any, and which providers this server has. */
export const repositoryQueryOptions = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: repositoryKeys.project(projectId),
    queryFn: () => api.getRepository(projectId),
    staleTime: 30_000
  });

export const failedDeliveriesQueryOptions = (
  api: ApiClient,
  projectId: string
) =>
  queryOptions({
    queryKey: repositoryKeys.deliveries(projectId),
    queryFn: () => api.listFailedRepositoryDeliveries(projectId)
  });

export const repositoryCandidatesQueryOptions = (
  api: ApiClient,
  projectId: string,
  authorizationId: string
) =>
  queryOptions({
    queryKey: repositoryKeys.candidates(projectId, authorizationId),
    queryFn: () => api.listRepositoryCandidates(projectId, authorizationId),
    retry: false,
    staleTime: Infinity
  });
