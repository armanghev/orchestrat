import { queryOptions } from "@tanstack/react-query";
import type { ApiClient } from "@/lib/api/client";

export const messagingKeys = {
  all: ["messaging"] as const,
  chats: (projectId: string) =>
    [...messagingKeys.all, "chats", projectId] as const,
  candidates: (projectId: string) =>
    [...messagingKeys.all, "candidates", projectId] as const,
  inbox: (projectId: string) =>
    [...messagingKeys.all, "inbox", projectId] as const,
  chat: (chatId: string) => [...messagingKeys.all, "chat", chatId] as const,
  messages: (chatId: string) =>
    [...messagingKeys.all, "messages", chatId] as const
};

export const chatsQueryOptions = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: messagingKeys.chats(projectId),
    queryFn: () => api.listChats(projectId),
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

export const inboxQueryOptions = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: messagingKeys.inbox(projectId),
    queryFn: () => api.getProjectInbox(projectId),
    staleTime: 5_000
  });
