import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { RealtimeEventEnvelope } from "@orchestrat/protocol";
import type { ApiClient } from "@/lib/api/client";
import { messagingKeys } from "@/features/messaging/query-options";
import { attentionKeys } from "@/features/attention/query-options";
import { branchKeys } from "@/features/branches/query-options";
import { repositoryKeys } from "@/features/repository/query-options";

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

// Tasks, documents and events belong to a branch (docs/project-branches.md
// §11.3). The branch is the last key part, so a key without it is a prefix
// that matches every branch of the project. Presence stays project-wide: it
// lists every agent with the branch each one is on.
const scoped = (branchId?: string) => (branchId ? [branchId] : []);

/** The events key part for Activity's "All branches" view. */
export const ALL_BRANCHES = "all-branches";

export const coordinationKeys = {
  all: ["coordination"] as const,
  tasks: (projectId: string, branchId?: string) =>
    [...coordinationKeys.all, "tasks", projectId, ...scoped(branchId)] as const,
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
  events: (projectId: string, branchId?: string) =>
    [
      ...coordinationKeys.all,
      "events",
      projectId,
      ...scoped(branchId)
    ] as const,
  eventsInfinite: (projectId: string, branchId?: string) =>
    [...coordinationKeys.events(projectId, branchId), "infinite"] as const,
  documents: (projectId: string, branchId?: string) =>
    [
      ...coordinationKeys.all,
      "documents",
      projectId,
      ...scoped(branchId)
    ] as const,
  document: (documentId: string) =>
    [...coordinationKeys.all, "document", documentId] as const,
  revisions: (documentId: string) =>
    [...coordinationKeys.all, "revisions", documentId] as const,
  revisionSummary: (documentId: string) =>
    [...coordinationKeys.revisions(documentId), "summary"] as const,
  attachments: (documentId: string) =>
    [...coordinationKeys.all, "attachments", documentId] as const
};

export const tasksQueryOptions = (
  api: ApiClient,
  projectId: string,
  branchId?: string
) =>
  queryOptions({
    queryKey: coordinationKeys.tasks(projectId, branchId),
    // The board, Overview counts and task links need every task, so follow
    // the cursor instead of stopping at the API's first page.
    queryFn: async () => {
      const first = await api.listTasks(
        projectId,
        { limit: 100 },
        { branchId }
      );
      const tasks = [...first.tasks];
      const seen = new Set<string>();
      let cursor = first.next_cursor;
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const page = await api.listTasks(
          projectId,
          { limit: 100, cursor },
          { branchId }
        );
        tasks.push(...page.tasks);
        cursor = page.next_cursor;
      }
      return { ...first, tasks, next_cursor: null };
    }
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

/** The branch's events plus project-wide ones (agents, branches). */
export const projectEventsQueryOptions = (
  api: ApiClient,
  projectId: string,
  branchId?: string
) =>
  queryOptions({
    queryKey: coordinationKeys.events(projectId, branchId),
    queryFn: () => api.listProjectEvents(projectId, {}, { branchId })
  });

/** Every branch's events, for views that follow agents across branches. */
export const allBranchEventsQueryOptions = (
  api: ApiClient,
  projectId: string
) =>
  queryOptions({
    queryKey: coordinationKeys.events(projectId, ALL_BRANCHES),
    queryFn: () => api.listProjectEvents(projectId, {}, { allBranches: true })
  });

export const documentsQueryOptions = (
  api: ApiClient,
  projectId: string,
  branchId?: string
) =>
  queryOptions({
    queryKey: coordinationKeys.documents(projectId, branchId),
    queryFn: () =>
      api.listDocuments(projectId, { include_archived: true }, { branchId })
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
  return Promise.all(
    [
      coordinationKeys.tasks(projectId),
      coordinationKeys.agents(projectId),
      coordinationKeys.presence(projectId),
      coordinationKeys.events(projectId),
      coordinationKeys.documents(projectId),
      messagingKeys.chats(projectId),
      messagingKeys.inbox(projectId),
      attentionKeys.project(projectId),
      branchKeys.project(projectId)
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey }))
  );
}

type QueryKey = readonly unknown[];

/** Entity keys a merge or a resolved decision can change on its target; the
 * envelope doesn't say which items, so every cached one is refreshed. */
const mergedEntityKeys: QueryKey[] = [
  [...coordinationKeys.all, "task"],
  [...coordinationKeys.all, "comments"],
  [...coordinationKeys.all, "dependencies"],
  [...coordinationKeys.all, "document"],
  [...coordinationKeys.all, "revisions"],
  [...coordinationKeys.all, "attachments"],
  [...messagingKeys.all, "chat"],
  [...messagingKeys.all, "messages"]
];

export function invalidateRealtimeEvent(
  queryClient: QueryClient,
  projectId: string,
  event: RealtimeEventEnvelope
) {
  // null marks a project-wide event and older servers send no branch_id; in
  // both cases the prefix keys refresh every branch (spec §11.4).
  const branchId = event.branch_id ?? undefined;
  const invalidate = (keys: QueryKey[]) =>
    Promise.all(
      keys.map((queryKey) => queryClient.invalidateQueries({ queryKey }))
    );
  // A branch's events also appear in Activity's all-branches view.
  const events: QueryKey[] = branchId
    ? [
        coordinationKeys.events(projectId, branchId),
        coordinationKeys.events(projectId, ALL_BRANCHES)
      ]
    : [coordinationKeys.events(projectId)];
  const inbox: QueryKey[] = branchId
    ? [
        messagingKeys.inbox(projectId, branchId),
        messagingKeys.inboxAllBranches(projectId)
      ]
    : [messagingKeys.inbox(projectId)];
  if (event.entity_type === "branch")
    return invalidate([branchKeys.project(projectId), ...events]);
  // Connecting can rename or move the default branch.
  if (event.entity_type === "repository")
    return invalidate([
      repositoryKeys.project(projectId),
      branchKeys.project(projectId),
      ...events
    ]);
  if (event.entity_type === "merge" || event.entity_type === "decision")
    return invalidate([
      branchKeys.project(projectId),
      coordinationKeys.tasks(projectId, branchId),
      coordinationKeys.documents(projectId, branchId),
      messagingKeys.chats(projectId, branchId),
      ...inbox,
      attentionKeys.project(projectId),
      ...mergedEntityKeys,
      ...events
    ]);
  if (event.entity_type === "chat" && event.entity_id) {
    const chatId = event.entity_id;
    const invalidations = [
      invalidate([
        messagingKeys.chats(projectId, branchId),
        ...inbox,
        messagingKeys.chat(chatId),
        messagingKeys.messages(chatId)
      ])
    ];
    // A handoff changes the recipient's pending items and blockers.
    if (event.event_type === "chat.handoff_created")
      invalidations.push(invalidate([attentionKeys.project(projectId)]));
    if (event.event_type === "chat.access_invalidated") {
      queryClient.removeQueries({ queryKey: messagingKeys.chat(chatId) });
      queryClient.removeQueries({ queryKey: messagingKeys.messages(chatId) });
      queryClient.setQueriesData<{ chats: Array<{ id: string }> }>(
        { queryKey: messagingKeys.chats(projectId) },
        (current) =>
          current && {
            ...current,
            chats: current.chats.filter((chat) => chat.id !== chatId)
          }
      );
    }
    return Promise.all(invalidations);
  }
  if (event.entity_type === "document")
    return invalidate([
      coordinationKeys.documents(projectId, branchId),
      ...(event.entity_id
        ? [
            coordinationKeys.document(event.entity_id),
            coordinationKeys.revisions(event.entity_id),
            coordinationKeys.attachments(event.entity_id)
          ]
        : []),
      ...events
    ]);
  if (!knownRealtimeEventTypes.has(event.event_type))
    return invalidateCoordinationQueries(queryClient, projectId);
  const entity = event.entity_type;
  // A wake only changes activity and the agent's attention line.
  if (event.event_type === "run.woken")
    return invalidate([...events, attentionKeys.project(projectId)]);
  if (["run", "hook"].includes(entity))
    return invalidateCoordinationQueries(queryClient, projectId);
  // Task and claim events can change the viewer's unread counts, watches or
  // the claim overlay, none of which realtime payloads carry.
  const attention =
    entity === "task" || entity === "claim"
      ? [attentionKeys.project(projectId)]
      : [];
  const tasks = coordinationKeys.tasks(projectId, branchId);
  const keys =
    entity === "claim"
      ? [tasks, coordinationKeys.presence(projectId)]
      : entity === "task"
        ? event.event_type === "task.comment_created"
          ? [tasks, coordinationKeys.commentsAll()]
          : event.event_type.startsWith("task.dependency_")
            ? [
                tasks,
                ...(event.entity_id
                  ? [
                      coordinationKeys.task(event.entity_id),
                      coordinationKeys.dependencies(event.entity_id)
                    ]
                  : [coordinationKeys.dependenciesAll()])
              ]
            : [
                tasks,
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
  return invalidate([...keys, ...attention, ...events]);
}
