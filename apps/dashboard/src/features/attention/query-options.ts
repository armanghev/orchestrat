import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type {
  AttentionSummary,
  TaskAttentionOverlay
} from "@orchestrat/protocol";
import type { ApiClient } from "@/lib/api/client";

// Watches and read positions are private to the viewer (spec §14), so every
// attention query is keyed by project and refetched rather than patched from
// realtime payloads.
export const attentionKeys = {
  all: ["attention"] as const,
  project: (projectId: string) => [...attentionKeys.all, projectId] as const,
  summary: (projectId: string) =>
    [...attentionKeys.project(projectId), "summary"] as const,
  tasks: (projectId: string) =>
    [...attentionKeys.project(projectId), "tasks"] as const,
  agents: (projectId: string) =>
    [...attentionKeys.project(projectId), "agents"] as const
};

export const attentionSummaryQueryOptions = (
  api: ApiClient,
  projectId: string
) =>
  queryOptions({
    queryKey: attentionKeys.summary(projectId),
    queryFn: () => api.getProjectAttention(projectId),
    staleTime: 5_000
  });

export const taskAttentionQueryOptions = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: attentionKeys.tasks(projectId),
    queryFn: () => api.listTaskAttention(projectId),
    staleTime: 5_000
  });

/** Agent status lines on the Agents page, refreshed every 30 s (spec §14). */
export const agentAttentionQueryOptions = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: attentionKeys.agents(projectId),
    queryFn: () => api.listAgentAttention(projectId),
    staleTime: 5_000,
    refetchInterval: 30_000
  });

export function invalidateAttentionQueries(
  queryClient: QueryClient,
  projectId: string
) {
  return queryClient.invalidateQueries({
    queryKey: attentionKeys.project(projectId)
  });
}

export function taskCommentCounts(summary: AttentionSummary | undefined) {
  return (summary?.tasks ?? []).reduce(
    (counts, task) => ({
      unread: counts.unread + task.unread_count,
      mentions: counts.mentions + task.mention_count
    }),
    { unread: 0, mentions: 0 }
  );
}

export function overlaysByTask(overlays: TaskAttentionOverlay[] | undefined) {
  return new Map((overlays ?? []).map((overlay) => [overlay.task_id, overlay]));
}

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

export function unreadCommentsLabel(
  unread: number,
  mentions: number,
  noun = "unread comment"
) {
  return `${plural(unread, noun)}${mentions ? `, ${plural(mentions, "mention")}` : ""}`;
}
