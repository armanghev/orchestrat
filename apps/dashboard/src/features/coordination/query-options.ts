import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/lib/api/client";

export const coordinationKeys = {
  all: ["coordination"] as const,
  tasks: (projectId: string) =>
    [...coordinationKeys.all, "tasks", projectId] as const,
  task: (taskId: string) => [...coordinationKeys.all, "task", taskId] as const,
  comments: (taskId: string) =>
    [...coordinationKeys.all, "comments", taskId] as const,
  dependencies: (taskId: string) =>
    [...coordinationKeys.all, "dependencies", taskId] as const,
  agents: (projectId: string) =>
    [...coordinationKeys.all, "agents", projectId] as const,
  presence: (projectId: string) =>
    [...coordinationKeys.all, "presence", projectId] as const,
  events: (projectId: string) =>
    [...coordinationKeys.all, "events", projectId] as const,
  documents: (projectId: string) =>
    [...coordinationKeys.all, "documents", projectId] as const,
  document: (documentId: string) =>
    [...coordinationKeys.all, "document", documentId] as const,
  revisions: (documentId: string) =>
    [...coordinationKeys.all, "revisions", documentId] as const
};

export const tasksQueryOptions = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: coordinationKeys.tasks(projectId),
    queryFn: () => api.listTasks(projectId)
  });

export const taskQueryOptions = (api: ApiClient, taskId: string) =>
  queryOptions({
    queryKey: coordinationKeys.task(taskId),
    queryFn: () => api.getTask(taskId)
  });

export const taskCommentsQueryOptions = (api: ApiClient, taskId: string) =>
  queryOptions({
    queryKey: coordinationKeys.comments(taskId),
    queryFn: () => api.listTaskComments(taskId)
  });

export const taskDependenciesQueryOptions = (api: ApiClient, taskId: string) =>
  queryOptions({
    queryKey: coordinationKeys.dependencies(taskId),
    queryFn: () => api.getTaskDependencies(taskId)
  });

export const agentsQueryOptions = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: coordinationKeys.agents(projectId),
    queryFn: () => api.listAgents(projectId)
  });

export const agentPresenceQueryOptions = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: coordinationKeys.presence(projectId),
    queryFn: () => api.getAgentPresence(projectId)
  });

export const projectEventsQueryOptions = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: coordinationKeys.events(projectId),
    queryFn: () => api.listProjectEvents(projectId)
  });

export const documentsQueryOptions = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: coordinationKeys.documents(projectId),
    queryFn: () => api.listDocuments(projectId)
  });

export const documentQueryOptions = (api: ApiClient, documentId: string) =>
  queryOptions({
    queryKey: coordinationKeys.document(documentId),
    queryFn: () => api.getDocument(documentId)
  });

export const documentRevisionsQueryOptions = (
  api: ApiClient,
  documentId: string
) =>
  queryOptions({
    queryKey: coordinationKeys.revisions(documentId),
    queryFn: () => api.listDocumentRevisions(documentId)
  });

export function invalidateCoordinationQueries(
  queryClient: QueryClient,
  projectId: string
) {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: coordinationKeys.tasks(projectId)
    }),
    queryClient.invalidateQueries({
      queryKey: coordinationKeys.agents(projectId)
    }),
    queryClient.invalidateQueries({
      queryKey: coordinationKeys.presence(projectId)
    }),
    queryClient.invalidateQueries({
      queryKey: coordinationKeys.events(projectId)
    }),
    queryClient.invalidateQueries({
      queryKey: coordinationKeys.documents(projectId)
    })
  ]);
}
