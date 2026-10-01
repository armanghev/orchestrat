import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "@/lib/api/client";

// Chats and the inbox belong to a branch (docs/project-branches.md §11.3). The
// branch is the last key part, so a key without it is a prefix that matches
// every branch of the project.
const scoped = (branchId?: string) => (branchId ? [branchId] : []);

export const messagingKeys = {
  all: ["messaging"] as const,
  chats: (projectId: string, branchId?: string) =>
    [...messagingKeys.all, "chats", projectId, ...scoped(branchId)] as const,
  candidates: (projectId: string) =>
    [...messagingKeys.all, "candidates", projectId] as const,
  inbox: (projectId: string, branchId?: string) =>
    [...messagingKeys.all, "inbox", projectId, ...scoped(branchId)] as const,
  /** Unread counts for every branch, for the branch menu's unread dots. */
  inboxAllBranches: (projectId: string) =>
    [...messagingKeys.inbox(projectId), "all-branches"] as const,
  chat: (chatId: string) => [...messagingKeys.all, "chat", chatId] as const,
  messages: (chatId: string) =>
    [...messagingKeys.all, "messages", chatId] as const
};

export const chatsQueryOptions = (
  api: ApiClient,
  projectId: string,
  branchId?: string
) =>
  queryOptions({
    queryKey: messagingKeys.chats(projectId, branchId),
    queryFn: () => api.listChats(projectId, { branchId }),
    staleTime: 5_000
  });

export const messageCandidatesQueryOptions = (
  api: ApiClient,
  projectId: string
) =>
  queryOptions({
    queryKey: messagingKeys.candidates(projectId),
    queryFn: () => api.listMessageCandidates(projectId),
    staleTime: 60_000
  });

export const inboxQueryOptions = (
  api: ApiClient,
  projectId: string,
  branchId?: string
) =>
  queryOptions({
    queryKey: messagingKeys.inbox(projectId, branchId),
    queryFn: () => api.getProjectInbox(projectId, { branchId }),
    staleTime: 5_000
  });

export const inboxAllBranchesQueryOptions = (
  api: ApiClient,
  projectId: string
) =>
  queryOptions({
    queryKey: messagingKeys.inboxAllBranches(projectId),
    queryFn: () => api.getProjectInbox(projectId, { allBranches: true }),
    staleTime: 5_000
  });
