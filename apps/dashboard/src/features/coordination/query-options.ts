import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { RealtimeEventEnvelope } from "@orchestrat/protocol";
import type { ApiClient } from "@/lib/api/client";
import { messagingKeys } from "@/features/messaging/query-options";
import { attentionKeys } from "@/features/attention/query-options";

const knownRealtimeEventTypes = new Set([
  "task.created",
  "task.updated",
  "task.moved",
  "task.comment_created",
  "task.status_changed",
  "task.block_resolved",
  "task.dependency_added",
  "task.dependency_removed",
  "claim.created",
  "claim.released",
  "claim.completed",
  "claim.expired",
  "claim.revoked",
  "agent.created",
  "agent.revoked",
  "credential.issued",
  "credential.revoked",
  "session.opened",
  "session.closed",
  "session.started",
  "session.ended",
  "session.stopped",
  "session.heartbeat",
  "document.created",
  "document.updated",
  "chat.created",
  "chat.member_added",
  "chat.member_removed",
  "chat.message_created",
  "chat.access_invalidated",
  "chat.handoff_created",
  "hook.triggered",
  "run.failed",
  "run.woken"
]);

export const coordinationKeys = {
  all: ["coordination"] as const,
  tasks: (projectId: string) =>
    [...coordinationKeys.all, "tasks", projectId] as const,
  task: (taskId: string) => [...coordinationKeys.all, "task", taskId] as const,
  comments: (taskId: string) =>
    [...coordinationKeys.all, "comments", taskId] as const,
  commentsAll: () => [...coordinationKeys.all, "comments"] as const,
  dependencies: (taskId: string) =>
    [...coordinationKeys.all, "dependencies", taskId] as const,
  dependenciesAll: () => [...coordinationKeys.all, "dependencies"] as const,
  agents: (projectId: string) =>
    [...coordinationKeys.all, "agents", projectId] as const,
  presence: (projectId: string) =>
    [...coordinationKeys.all, "presence", projectId] as const,
  events: (projectId: string) =>
    [...coordinationKeys.all, "events", projectId] as const,
  eventsInfinite: (projectId: string) =>
    [...coordinationKeys.events(projectId), "infinite"] as const,
  documents: (projectId: string) =>
    [...coordinationKeys.all, "documents", projectId] as const,
  document: (documentId: string) =>
    [...coordinationKeys.all, "document", documentId] as const,
  revisions: (documentId: string) =>
    [...coordinationKeys.all, "revisions", documentId] as const,
  revisionSummary: (documentId: string) =>
    [...coordinationKeys.revisions(documentId), "summary"] as const,
  attachments: (documentId: string) =>
    [...coordinationKeys.all, "attachments", documentId] as const
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
    queryFn: () => api.listDocuments(projectId, { include_archived: true })
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

export const documentRevisionSummaryQueryOptions = (
  api: ApiClient,
  documentId: string
) =>
  queryOptions({
    queryKey: coordinationKeys.revisionSummary(documentId),
    queryFn: () => api.listDocumentRevisionSummaries(documentId)
  });

export const documentAttachmentsQueryOptions = (
  api: ApiClient,
  documentId: string
) =>
  queryOptions({
    queryKey: coordinationKeys.attachments(documentId),
    queryFn: () => api.listDocumentAttachments(documentId)
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
    }),
    queryClient.invalidateQueries({
      queryKey: messagingKeys.chats(projectId)
    }),
    queryClient.invalidateQueries({
      queryKey: messagingKeys.inbox(projectId)
    }),
    queryClient.invalidateQueries({
      queryKey: attentionKeys.project(projectId)
    })
  ]);
}

export function invalidateRealtimeEvent(
  queryClient: QueryClient,
  projectId: string,
  event: RealtimeEventEnvelope
) {
  if (event.entity_type === "chat" && event.entity_id) {
    const chatId = event.entity_id;
    const invalidations = [
      queryClient.invalidateQueries({
        queryKey: messagingKeys.chats(projectId)
      }),
      queryClient.invalidateQueries({
        queryKey: messagingKeys.inbox(projectId)
      }),
      queryClient.invalidateQueries({ queryKey: messagingKeys.chat(chatId) }),
      queryClient.invalidateQueries({
        queryKey: messagingKeys.messages(chatId)
      })
    ];
    // A handoff changes the recipient's pending items and blockers.
    if (event.event_type === "chat.handoff_created")
      invalidations.push(
        queryClient.invalidateQueries({
          queryKey: attentionKeys.project(projectId)
        })
      );
    if (event.event_type === "chat.access_invalidated") {
      queryClient.removeQueries({ queryKey: messagingKeys.chat(chatId) });
      queryClient.removeQueries({ queryKey: messagingKeys.messages(chatId) });
      queryClient.setQueryData<{ chats: Array<{ id: string }> }>(
        messagingKeys.chats(projectId),
        (current) =>
          current && {
            ...current,
            chats: current.chats.filter((chat) => chat.id !== chatId)
          }
      );
    }
    return Promise.all(invalidations);
  }
  if (event.entity_type === "document") {
    const keys = [
      coordinationKeys.documents(projectId),
      ...(event.entity_id
        ? [
            coordinationKeys.document(event.entity_id),
            coordinationKeys.revisions(event.entity_id),
            coordinationKeys.attachments(event.entity_id)
          ]
        : [])
    ];
    return Promise.all([
      ...keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      queryClient.invalidateQueries({
        queryKey: coordinationKeys.events(projectId)
      })
    ]);
  }
  if (!knownRealtimeEventTypes.has(event.event_type))
    return invalidateCoordinationQueries(queryClient, projectId);
  const entity = event.entity_type;
  // A wake only changes activity and the agent's attention line.
  if (event.event_type === "run.woken")
    return Promise.all([
      queryClient.invalidateQueries({
        queryKey: coordinationKeys.events(projectId)
      }),
      queryClient.invalidateQueries({
        queryKey: attentionKeys.project(projectId)
      })
    ]);
  if (["run", "hook"].includes(entity))
    return invalidateCoordinationQueries(queryClient, projectId);
  // Task and claim events can change the viewer's unread counts, watches or
  // the claim overlay, none of which realtime payloads carry.
  const attention =
    entity === "task" || entity === "claim"
      ? [attentionKeys.project(projectId)]
      : [];
  const keys =
    entity === "claim"
      ? [
          coordinationKeys.tasks(projectId),
          coordinationKeys.presence(projectId)
        ]
      : entity === "task"
        ? event.event_type === "task.comment_created"
          ? [coordinationKeys.tasks(projectId), coordinationKeys.commentsAll()]
          : event.event_type.startsWith("task.dependency_")
            ? [
                coordinationKeys.tasks(projectId),
                ...(event.entity_id
                  ? [
                      coordinationKeys.task(event.entity_id),
                      coordinationKeys.dependencies(event.entity_id)
                    ]
                  : [coordinationKeys.dependenciesAll()])
              ]
            : [
                coordinationKeys.tasks(projectId),
                ...(event.entity_id
                  ? [coordinationKeys.task(event.entity_id)]
                  : [])
              ]
        : entity === "agent" || entity === "credential" || entity === "session"
          ? [
              coordinationKeys.agents(projectId),
              coordinationKeys.presence(projectId)
            ]
          : [];
  return Promise.all([
    ...[...keys, ...attention].map((queryKey) =>
      queryClient.invalidateQueries({ queryKey })
    ),
    queryClient.invalidateQueries({
      queryKey: coordinationKeys.events(projectId)
    })
  ]);
}
