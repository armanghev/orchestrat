import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import type {
  Chat,
  ChatMessage,
  MessageCandidate,
  ParticipantRef
} from "@orchestrat/protocol";
import {
  ArrowLeft,
  AtSign,
  Bot,
  Check,
  Eye,
  FileText,
  Hash,
  Info,
  Paperclip,
  Plus,
  Send,
  SquarePen,
  Users,
  X
} from "lucide-react";
import { TopToolbarActions } from "@/components/app-shell/app-shell";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownContent } from "@/features/coordination/markdown-content";
import { usePlatform } from "@/platform/provider";
import { documentsQueryOptions } from "@/features/coordination/query-options";
import { useBranch } from "@/features/branches/branch-context";
import { OtherBranchNotice } from "@/features/branches/other-branch-notice";
import { DashboardApiError } from "@/lib/api/client";
import {
  chatsQueryOptions,
  messageCandidatesQueryOptions,
  messagingKeys
} from "@/features/messaging/query-options";
import type { Document } from "@orchestrat/protocol";
import { cn } from "@/lib/cn";

const CHAT_DRAFT_PREFIX = "orchestrat:chat-draft:";
type Draft = {
  body: string;
  mentions: ParticipantRef[];
  documents: string[];
};
type PendingMessage = Draft & {
  userId: string;
  projectId: string;
  chatId: string;
  idempotencyKey: string;
};
type PendingChat = {
  input: {
    kind: "direct" | "group";
    name?: string;
    participants: ParticipantRef[];
  };
  idempotencyKey: string;
};

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/messages"
)({
  validateSearch: z.object({ chat: z.string().uuid().optional() }),
  component: MessagesRoute
});

const refKey = (participant: ParticipantRef) =>
  `${participant.type}:${participant.id}`;

function chatTitle(chat: Chat, currentUserId: string | undefined) {
  if (chat.kind === "group") return chat.name ?? "Group chat";
  const other = chat.participants.find(
    (participant) =>
      participant.type !== "human" || participant.id !== currentUserId
  );
  return other?.name ?? "Direct message";
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit"
});
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const shortDateFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric"
});
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "short",
  day: "numeric"
});
const GROUP_WINDOW_MS = 5 * 60 * 1000;

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysAgo(value: string) {
  return Math.round(
    (startOfDay(new Date()).getTime() - startOfDay(new Date(value)).getTime()) /
      86_400_000
  );
}

function listTime(value: string) {
  const days = daysAgo(value);
  if (days <= 0) return timeFormat.format(new Date(value));
  if (days < 7) return weekdayFormat.format(new Date(value));
  return shortDateFormat.format(new Date(value));
}

function dayLabel(value: string) {
  const days = daysAgo(value);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return dayFormat.format(new Date(value));
}

function initials(name: string) {
  const letters = name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]);
  return (letters.join("") || "?").toUpperCase();
}

type ChatSection = "direct" | "group" | "observer";
const chatSections: Array<{ id: ChatSection; title: string }> = [
  { id: "direct", title: "Direct messages" },
  { id: "group", title: "Group chats" },
  { id: "observer", title: "Agent conversations" }
];

function chatSection(chat: Chat): ChatSection {
  if (!chat.is_participant) return "observer";
  return chat.kind;
}

function draftKey(userId: string, projectId: string, chatId: string) {
  return `${CHAT_DRAFT_PREFIX}${userId}:${projectId}:${chatId}`;
}

function readDraft(userId: string, projectId: string, chatId: string): Draft {
  try {
    const value = window.localStorage.getItem(
      draftKey(userId, projectId, chatId)
    );
    if (!value) return { body: "", mentions: [], documents: [] };
    const parsed = JSON.parse(value) as Partial<Draft>;
    return {
      body: typeof parsed.body === "string" ? parsed.body : "",
      mentions: Array.isArray(parsed.mentions) ? parsed.mentions : [],
      documents: Array.isArray(parsed.documents) ? parsed.documents : []
    };
  } catch {
    return { body: "", mentions: [], documents: [] };
  }
}

function pendingMessageKey(userId: string, projectId: string, chatId: string) {
  return `${draftKey(userId, projectId, chatId)}:pending`;
}

function readPendingMessage(
  userId: string,
  projectId: string,
  chatId: string
): PendingMessage | null {
  try {
    const value = window.localStorage.getItem(
      pendingMessageKey(userId, projectId, chatId)
    );
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<PendingMessage>;
    if (
      parsed.chatId !== chatId ||
      parsed.projectId !== projectId ||
      parsed.userId !== userId ||
      typeof parsed.idempotencyKey !== "string" ||
      typeof parsed.body !== "string"
    )
      return null;
    return {
      userId,
      projectId,
      chatId,
      idempotencyKey: parsed.idempotencyKey,
      body: parsed.body,
      mentions: Array.isArray(parsed.mentions) ? parsed.mentions : [],
      documents: Array.isArray(parsed.documents) ? parsed.documents : []
    };
  } catch {
    return null;
  }
}

function removeStoredItem(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // A successful network send must remain successful when storage is unavailable.
  }
}

function ParticipantAvatar({
  participant,
  size = "md"
}: {
  participant: Pick<MessageCandidate, "name" | "type"> &
    Partial<Pick<MessageCandidate, "avatar_url">>;
  size?: "sm" | "md" | "lg";
}) {
  const box = size === "sm" ? "size-7" : size === "lg" ? "size-9" : "size-8";
  if (participant.type === "agent")
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-lg bg-secondary ring-1 ring-border",
          box
        )}
      >
        <Bot className={size === "lg" ? "size-[18px]" : "size-4"} />
      </span>
    );
  return (
    <Avatar className={cn("shrink-0", box)} aria-hidden="true">
      {participant.avatar_url ? (
        <AvatarImage src={participant.avatar_url} alt="" />
      ) : null}
      <AvatarFallback className="text-xs font-semibold">
        {initials(participant.name)}
      </AvatarFallback>
    </Avatar>
  );
}

function ChatAvatar({
  chat,
  currentUserId
}: {
  chat: Chat;
  currentUserId: string | undefined;
}) {
  if (chat.kind === "group")
    return (
      <span
        aria-hidden="true"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
      >
        <Hash className="size-4" />
      </span>
    );
  const other = chat.participants.find(
    (participant) =>
      participant.type !== "human" || participant.id !== currentUserId
  );
  return (
    <ParticipantAvatar participant={other ?? { name: "Chat", type: "human" }} />
  );
}

function MessagesRoute() {
  const { projectId } = Route.useParams();
  const { api } = Route.useRouteContext();
  const { chat } = Route.useSearch();
  const { branchId } = useBranch();
  const [search, setSearch] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => api.getProfile()
  });
  return (
    <MessagesWorkspace
      key={`${profile.data?.user_id ?? ""}:${projectId}:${branchId}:${chat ?? ""}`}
      search={search}
      setSearch={setSearch}
      detailsOpen={detailsOpen}
      setDetailsOpen={setDetailsOpen}
    />
  );
}

function MessagesWorkspace({
  search,
  setSearch,
  detailsOpen,
  setDetailsOpen
}: {
  search: string;
  setSearch: (search: string) => void;
  detailsOpen: boolean;
  setDetailsOpen: (open: boolean) => void;
}) {
  const { projectId } = Route.useParams();
  const { api } = Route.useRouteContext();
  const { chat: selectedChatId } = Route.useSearch();
  const { branchId, branchParam, branchArchived, readOnly } = useBranch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const platform = usePlatform();
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => api.getProfile()
  });
  const currentUserId = profile.data?.user_id;
  const activeContextKey = `${currentUserId ?? ""}:${projectId}:${selectedChatId ?? ""}`;
  const activeContextRef = useRef(activeContextKey);
  activeContextRef.current = activeContextKey;
  const chatsQuery = useQuery(chatsQueryOptions(api, projectId, branchId));
  const candidatesQuery = useQuery(
    messageCandidatesQueryOptions(api, projectId)
  );
  // Only this branch's documents can be attached.
  const documentsQuery = useQuery(
    documentsQueryOptions(api, projectId, branchId)
  );
  const chats = chatsQuery.data?.chats ?? [];
  const selectedChat = chats.find(({ id }) => id === selectedChatId);
  // A deep link to a chat this branch doesn't list may name another
  // branch's chat; its record says which.
  const linkedChat = useQuery({
    queryKey: messagingKeys.chat(selectedChatId ?? ""),
    queryFn: () => api.getChat(selectedChatId as string),
    enabled: Boolean(selectedChatId && chatsQuery.isSuccess && !selectedChat),
    retry: false
  });
  const elsewhereBranchId =
    linkedChat.data?.branch_id && linkedChat.data.branch_id !== branchId
      ? linkedChat.data.branch_id
      : undefined;
  const candidates = candidatesQuery.data?.candidates ?? [];
  const documents = documentsQuery.data?.documents ?? [];
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createSearch, setCreateSearch] = useState("");
  const [createParticipants, setCreateParticipants] = useState<
    ParticipantRef[]
  >([]);
  const createKind: "direct" | "group" =
    createParticipants.length > 1 ? "group" : "direct";
  const [createAttempt, setCreateAttempt] = useState<PendingChat | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [manageSearch, setManageSearch] = useState("");
  const [draft, setDraft] = useState<Draft>({
    body: "",
    mentions: [],
    documents: []
  });
  const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(
    null
  );
  const [sendError, setSendError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [olderBefore, setOlderBefore] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyAccessDenied, setHistoryAccessDenied] = useState(false);
  const [historySyncReady, setHistorySyncReady] = useState(false);
  const [historyRetryCount, setHistoryRetryCount] = useState(0);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [picker, setPicker] = useState<"mention" | "document" | null>(null);
  const [draftDocumentSearch, setDraftDocumentSearch] = useState("");
  const messagesQuery = useQuery({
    queryKey: messagingKeys.messages(selectedChatId ?? ""),
    queryFn: () => api.listChatMessages(selectedChatId as string),
    enabled: Boolean(selectedChatId && selectedChat && !historyAccessDenied),
    staleTime: 0
  });
  const messageListRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const pendingReadTimerRef = useRef<number | null>(null);
  const maxVisibleSequenceRef = useRef(0);
  const readPositionRef = useRef(0);
  const olderHistoryInitializedRef = useRef(false);
  const latestSnapshotReceivedRef = useRef(false);
  const participantBackfillDoneRef = useRef(false);
  const highestReceivedSequenceRef = useRef(0);
  const historyTargetSequenceRef = useRef(0);
  const historySyncInFlightRef = useRef(false);
  const historySyncReadyRef = useRef(false);
  const historyGenerationRef = useRef(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const sendInFlightRef = useRef(false);
  const hasOlder = olderBefore !== null;
  const historyForbidden =
    messagesQuery.error instanceof DashboardApiError &&
    messagesQuery.error.status === 403;

  const refreshChats = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: messagingKeys.chats(projectId)
      }),
      queryClient.invalidateQueries({
        queryKey: messagingKeys.inbox(projectId)
      })
    ]);
  }, [projectId, queryClient]);

  const createMutation = useMutation({
    mutationFn: (attempt: PendingChat) =>
      api.createChat(projectId, attempt.input, attempt.idempotencyKey, {
        branchId
      }),
    onSuccess: async (chat) => {
      setCreateError(null);
      setCreateAttempt(null);
      setCreateOpen(false);
      setCreateParticipants([]);
      setCreateName("");
      await refreshChats();
      void navigate({
        to: "/projects/$projectId/messages",
        params: { projectId },
        search: { chat: chat.id }
      });
    },
    onError: (error) =>
      setCreateError(
        error instanceof Error ? error.message : "Could not create chat."
      )
  });
  const memberMutation = useMutation({
    mutationFn: (input: {
      action: "add" | "remove";
      participant: ParticipantRef;
    }) => api.manageChatMembers(selectedChatId as string, input),
    onSuccess: refreshChats
  });
  const joinMutation = useMutation({
    mutationFn: () => api.joinChat(selectedChatId as string),
    onSuccess: async (chat) => {
      await refreshChats();
      void navigate({
        to: "/projects/$projectId/messages",
        params: { projectId },
        search: { chat: chat.id }
      });
    }
  });
  const sendMutation = useMutation({
    mutationFn: (attempt: PendingMessage) =>
      api.sendChatMessage(
        attempt.chatId,
        {
          body_markdown: attempt.body,
          mentions: attempt.mentions,
          document_ids: attempt.documents
        },
        attempt.idempotencyKey
      ),
    onSuccess: async (message, attempt) => {
      const attemptContext = `${attempt.userId}:${attempt.projectId}:${attempt.chatId}`;
      if (activeContextRef.current === attemptContext) {
        setMessages((current) =>
          current.some(({ id }) => id === message.id)
            ? current
            : [...current, message].sort(
                (left, right) => left.sequence - right.sequence
              )
        );
        if (
          JSON.stringify(draftRef.current) ===
          JSON.stringify({
            body: attempt.body,
            mentions: attempt.mentions,
            documents: attempt.documents
          })
        )
          setDraft({ body: "", mentions: [], documents: [] });
        setPendingMessage((current) =>
          current?.idempotencyKey === attempt.idempotencyKey ? null : current
        );
        setSendError(null);
      }
      sendInFlightRef.current = false;
      const pendingKey = pendingMessageKey(
        attempt.userId,
        attempt.projectId,
        attempt.chatId
      );
      if (
        readPendingMessage(attempt.userId, attempt.projectId, attempt.chatId)
          ?.idempotencyKey === attempt.idempotencyKey
      )
        removeStoredItem(pendingKey);
      const currentStoredDraft = readDraft(
        attempt.userId,
        attempt.projectId,
        attempt.chatId
      );
      if (
        JSON.stringify(currentStoredDraft) ===
        JSON.stringify({
          body: attempt.body,
          mentions: attempt.mentions,
          documents: attempt.documents
        })
      )
        removeStoredItem(
          draftKey(attempt.userId, attempt.projectId, attempt.chatId)
        );
      await refreshChats();
      void queryClient.invalidateQueries({
        queryKey: messagingKeys.messages(attempt.chatId)
      });
    },
    onError: (error, attempt) => {
      sendInFlightRef.current = false;
      const definitivelyRejected =
        error instanceof DashboardApiError &&
        (error.status === 400 || error.status === 422);
      if (definitivelyRejected) {
        const stored = readPendingMessage(
          attempt.userId,
          attempt.projectId,
          attempt.chatId
        );
        if (stored?.idempotencyKey === attempt.idempotencyKey)
          removeStoredItem(
            pendingMessageKey(attempt.userId, attempt.projectId, attempt.chatId)
          );
        if (
          activeContextRef.current ===
          `${attempt.userId}:${attempt.projectId}:${attempt.chatId}`
        ) {
          setPendingMessage((current) =>
            current?.idempotencyKey === attempt.idempotencyKey ? null : current
          );
          setSendError(error.message);
        }
        return;
      }
      try {
        window.localStorage.setItem(
          pendingMessageKey(attempt.userId, attempt.projectId, attempt.chatId),
          JSON.stringify(attempt)
        );
      } catch {
        // Keep the retry in memory when browser storage is unavailable.
      }
      if (
        activeContextRef.current !==
        `${attempt.userId}:${attempt.projectId}:${attempt.chatId}`
      )
        return;
      setSendError(
        error instanceof Error ? error.message : "Message could not be sent."
      );
      setPendingMessage(attempt);
    }
  });

  useEffect(() => {
    const generation = ++historyGenerationRef.current;
    return () => {
      if (historyGenerationRef.current === generation)
        historyGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (historyForbidden) {
      setMessages([]);
      return;
    }
    if (!selectedChatId || !selectedChat || !messagesQuery.data) {
      setMessages([]);
      return;
    }
    const incoming = messagesQuery.data.messages;
    setMessages((current) => {
      if (current.length === 0) return incoming;
      const merged = new Map(current.map((message) => [message.id, message]));
      for (const message of incoming) merged.set(message.id, message);
      return [...merged.values()].sort(
        (left, right) => left.sequence - right.sequence
      );
    });
    if (!olderHistoryInitializedRef.current) {
      olderHistoryInitializedRef.current = true;
      setOlderBefore(messagesQuery.data.next_before);
    }
  }, [historyForbidden, messagesQuery.data, selectedChat, selectedChatId]);

  useEffect(() => {
    if (!historyForbidden || !selectedChatId) return;
    setHistoryAccessDenied(true);
    setMessages([]);
    setOlderBefore(null);
    setHistorySyncReady(false);
    queryClient.setQueriesData<{ chats: Chat[] }>(
      { queryKey: messagingKeys.chats(projectId) },
      (current) =>
        current && {
          ...current,
          chats: current.chats.filter(({ id }) => id !== selectedChatId)
        }
    );
    queryClient.removeQueries({
      queryKey: messagingKeys.messages(selectedChatId),
      exact: true
    });
    queryClient.removeQueries({
      queryKey: messagingKeys.chat(selectedChatId),
      exact: true
    });
    void Promise.all([
      queryClient.invalidateQueries({
        queryKey: messagingKeys.chats(projectId)
      }),
      queryClient.invalidateQueries({
        queryKey: messagingKeys.inbox(projectId)
      })
    ]);
  }, [historyForbidden, projectId, queryClient, selectedChatId]);

  useEffect(() => {
    if (!selectedChatId || !selectedChat || !messagesQuery.data) return;
    const target = Math.max(
      selectedChat.last_sequence,
      ...messagesQuery.data.messages.map(({ sequence }) => sequence),
      0
    );
    historyTargetSequenceRef.current = Math.max(
      historyTargetSequenceRef.current,
      target
    );
    const firstSnapshot = !latestSnapshotReceivedRef.current;
    latestSnapshotReceivedRef.current = true;
    const latestSnapshotMax = Math.max(
      ...messagesQuery.data.messages.map(({ sequence }) => sequence),
      0
    );
    const needsParticipantBackfill =
      selectedChat.is_participant &&
      !participantBackfillDoneRef.current &&
      selectedChat.unread_count > 0;
    if (firstSnapshot && !needsParticipantBackfill) {
      highestReceivedSequenceRef.current = Math.max(
        highestReceivedSequenceRef.current,
        latestSnapshotMax
      );
      if (selectedChat.is_participant)
        participantBackfillDoneRef.current = true;
      if (latestSnapshotMax >= target) {
        historySyncReadyRef.current = true;
        setHistorySyncReady(true);
        return;
      }
    }
    if (historySyncInFlightRef.current) return;
    const baseline = needsParticipantBackfill
      ? selectedChat.last_read_sequence
      : highestReceivedSequenceRef.current;
    if (!needsParticipantBackfill && target <= baseline) {
      highestReceivedSequenceRef.current = Math.max(
        highestReceivedSequenceRef.current,
        target
      );
      historySyncReadyRef.current = true;
      setHistorySyncReady(true);
      return;
    }

    const requestedContext = activeContextRef.current;
    const generation = historyGenerationRef.current;
    const launchTarget = historyTargetSequenceRef.current;
    historySyncReadyRef.current = false;
    setHistorySyncReady(false);
    historySyncInFlightRef.current = true;
    setHistoryError(null);
    void (async () => {
      const recovered: ChatMessage[] = [];
      let cursor = baseline;
      while (cursor < historyTargetSequenceRef.current) {
        const page = await api.listChatMessages(selectedChatId, {
          after: cursor,
          limit: 100
        });
        if (
          historyGenerationRef.current !== generation ||
          activeContextRef.current !== requestedContext
        )
          return;
        if (!page.messages.length) break;
        recovered.push(...page.messages);
        const lastSequence = page.messages.at(-1)?.sequence ?? cursor;
        if (lastSequence <= cursor) break;
        cursor = lastSequence;
        if (cursor < historyTargetSequenceRef.current && !page.has_more) break;
      }
      if (
        historyGenerationRef.current !== generation ||
        activeContextRef.current !== requestedContext
      )
        return;
      if (recovered.length) {
        setMessages((current) => {
          const merged = new Map(
            current.map((message) => [message.id, message])
          );
          for (const message of recovered) merged.set(message.id, message);
          return [...merged.values()].sort(
            (left, right) => left.sequence - right.sequence
          );
        });
      }
      highestReceivedSequenceRef.current = Math.max(
        highestReceivedSequenceRef.current,
        cursor
      );
      const complete = cursor >= historyTargetSequenceRef.current;
      if (complete) {
        if (selectedChat.is_participant)
          participantBackfillDoneRef.current = true;
        historySyncReadyRef.current = true;
        setHistorySyncReady(true);
      } else {
        setHistoryError(
          "Some messages could not be synchronized. Retry to load the complete conversation."
        );
      }
    })()
      .catch((error: unknown) => {
        if (
          historyGenerationRef.current === generation &&
          activeContextRef.current === requestedContext
        )
          setHistoryError(
            error instanceof Error
              ? error.message
              : "Messages could not be synchronized."
          );
      })
      .finally(() => {
        if (historyGenerationRef.current === generation) {
          historySyncInFlightRef.current = false;
          if (historyTargetSequenceRef.current > launchTarget)
            setHistoryRetryCount((current) => current + 1);
        }
      });
  }, [
    api,
    historyRetryCount,
    messagesQuery.data,
    selectedChat,
    selectedChatId
  ]);

  useEffect(() => {
    if (!selectedChatId || !currentUserId) {
      setDraft({ body: "", mentions: [], documents: [] });
      setPendingMessage(null);
      return;
    }
    setDraft(readDraft(currentUserId, projectId, selectedChatId));
    const pending = readPendingMessage(
      currentUserId,
      projectId,
      selectedChatId
    );
    setPendingMessage(pending);
    setSendError(
      pending
        ? "A previous send did not finish. Retry with the same key to safely confirm delivery."
        : null
    );
    setHistoryError(null);
    maxVisibleSequenceRef.current = 0;
  }, [currentUserId, projectId, selectedChatId]);

  useEffect(() => {
    if (!selectedChatId || !selectedChat?.is_participant) return;
    readPositionRef.current = Math.max(
      readPositionRef.current,
      selectedChat.last_read_sequence
    );
  }, [
    selectedChat?.is_participant,
    selectedChat?.last_read_sequence,
    selectedChatId
  ]);

  useEffect(() => {
    if (!selectedChatId || !selectedChat || !currentUserId) return;
    try {
      window.localStorage.setItem(
        draftKey(currentUserId, projectId, selectedChatId),
        JSON.stringify(draft)
      );
    } catch {
      // Draft recovery is best effort when browser storage is unavailable.
    }
  }, [currentUserId, draft, projectId, selectedChat, selectedChatId]);

  useEffect(() => {
    if (!selectedChatId || !selectedChat || !messages.length) return;
    const element = messageListRef.current;
    if (!element) return;
    if (wasAtBottomRef.current || messagesQuery.isFetchedAfterMount === false) {
      element.scrollTop = element.scrollHeight;
      wasAtBottomRef.current = true;
    }
  }, [
    messages.length,
    selectedChat,
    selectedChatId,
    messagesQuery.isFetchedAfterMount
  ]);

  useEffect(() => {
    if (
      !historySyncReady ||
      !selectedChatId ||
      !selectedChat?.is_participant ||
      !messages.length
    )
      return;
    const root = messageListRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || document.visibilityState !== "visible")
            continue;
          const sequence = Number(
            (entry.target as HTMLElement).dataset.sequence
          );
          if (Number.isFinite(sequence))
            maxVisibleSequenceRef.current = Math.max(
              maxVisibleSequenceRef.current,
              sequence
            );
        }
        if (maxVisibleSequenceRef.current <= readPositionRef.current) return;
        if (pendingReadTimerRef.current !== null)
          window.clearTimeout(pendingReadTimerRef.current);
        pendingReadTimerRef.current = window.setTimeout(() => {
          if (!historySyncReadyRef.current) return;
          const requestedContext = activeContextRef.current;
          void (async () => {
            const through = [...messages]
              .reverse()
              .find(
                ({ sequence }) => sequence <= maxVisibleSequenceRef.current
              );
            if (
              !historySyncReadyRef.current ||
              !through ||
              document.visibilityState !== "visible"
            )
              return;
            if (
              platform.kind === "desktop" &&
              (await platform.isBackgrounded?.())
            )
              return;
            if (activeContextRef.current !== requestedContext) return;
            readPositionRef.current = through.sequence;
            await api.acknowledgeChatMessages(selectedChatId, through.id);
            await refreshChats();
          })().catch(() => {
            readPositionRef.current = selectedChat.last_read_sequence;
          });
        }, 400);
      },
      { root, threshold: 0.5 }
    );
    for (const element of root.querySelectorAll<HTMLElement>("[data-sequence]"))
      observer.observe(element);
    return () => {
      observer.disconnect();
      if (pendingReadTimerRef.current !== null)
        window.clearTimeout(pendingReadTimerRef.current);
      pendingReadTimerRef.current = null;
    };
  }, [
    api,
    historySyncReady,
    messages,
    platform,
    refreshChats,
    selectedChat,
    selectedChatId
  ]);

  const visibleChats = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return chats
      .filter(
        (chat) =>
          !term ||
          chatTitle(chat, profile.data?.user_id)
            .toLocaleLowerCase()
            .includes(term) ||
          chat.participants.some(({ name }) =>
            name.toLocaleLowerCase().includes(term)
          )
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }, [chats, profile.data?.user_id, search]);
  const existingRefs = new Set((selectedChat?.participants ?? []).map(refKey));
  const chatCandidates = candidates.filter(
    (candidate) => !existingRefs.has(refKey(candidate))
  );
  const filteredCandidates = candidates.filter((candidate) =>
    candidate.name
      .toLocaleLowerCase()
      .includes(createSearch.trim().toLocaleLowerCase())
  );
  const filteredManageCandidates = chatCandidates.filter((candidate) =>
    candidate.name
      .toLocaleLowerCase()
      .includes(manageSearch.trim().toLocaleLowerCase())
  );
  const filteredDocuments = documents.filter((document) =>
    document.path
      .toLocaleLowerCase()
      .includes(draftDocumentSearch.trim().toLocaleLowerCase())
  );
  // Candidates exclude the current user, so chat participants and the profile fill in their avatar.
  const participantByKey = new Map(
    candidates.map((candidate) => [refKey(candidate), candidate])
  );
  for (const participant of selectedChat?.participants ?? []) {
    const known = participantByKey.get(refKey(participant));
    if (!known?.avatar_url)
      participantByKey.set(refKey(participant), participant);
  }
  const withAvatar = <
    T extends ParticipantRef & { avatar_url?: string | null }
  >(
    participant: T
  ): T =>
    participant.type === "human" &&
    participant.id === currentUserId &&
    !participant.avatar_url
      ? { ...participant, avatar_url: profile.data?.avatar_url ?? null }
      : participant;

  const submitCreate = (retry = false) => {
    if (createMutation.isPending) return;
    let attempt = retry ? createAttempt : null;
    if (!attempt) {
      if (createParticipants.length < 1)
        return setCreateError("Choose at least one recipient.");
      if (createKind === "group" && !createName.trim())
        return setCreateError("Name the group chat.");
      attempt = {
        input: {
          kind: createKind,
          ...(createKind === "group" ? { name: createName.trim() } : {}),
          participants: createParticipants
        },
        idempotencyKey: crypto.randomUUID()
      };
      setCreateAttempt(attempt);
    }
    setCreateError(null);
    createMutation.mutate(attempt);
  };

  const beginSend = (retry = false) => {
    if (
      !selectedChatId ||
      !selectedChat?.is_participant ||
      sendMutation.isPending ||
      sendInFlightRef.current
    )
      return;
    if (pendingMessage && !retry) return;
    let attempt = retry ? pendingMessage : null;
    if (!attempt) {
      if (!draft.body.trim() || !currentUserId) return;
      attempt = {
        ...draft,
        userId: currentUserId,
        projectId,
        chatId: selectedChatId,
        idempotencyKey: crypto.randomUUID()
      };
      setPendingMessage(attempt);
      try {
        window.localStorage.setItem(
          pendingMessageKey(currentUserId, projectId, selectedChatId),
          JSON.stringify(attempt)
        );
      } catch {
        // The in-memory attempt remains available for this view.
      }
    }
    sendInFlightRef.current = true;
    setSendError(null);
    sendMutation.mutate(attempt);
  };

  const toggleParticipant = (participant: ParticipantRef) => {
    setCreateParticipants((current) =>
      current.some((item) => refKey(item) === refKey(participant))
        ? current.filter((item) => refKey(item) !== refKey(participant))
        : [...current, { type: participant.type, id: participant.id }]
    );
  };

  const addMention = (participant: MessageCandidate) => {
    setDraft((current) => ({
      ...current,
      body: `${current.body}${current.body && !current.body.endsWith(" ") ? " " : ""}@${participant.name.replace(/\s+/gu, "_")} `,
      mentions: current.mentions.some(
        (item) => refKey(item) === refKey(participant)
      )
        ? current.mentions
        : [...current.mentions, { type: participant.type, id: participant.id }]
    }));
    setPicker(null);
  };

  const addDocument = (document: Document) => {
    setDraft((current) => ({
      ...current,
      documents: current.documents.includes(document.id)
        ? current.documents
        : [...current.documents, document.id]
    }));
    setDraftDocumentSearch("");
    setPicker(null);
  };

  const loadOlder = async () => {
    if (!selectedChatId || !messages[0] || loadingOlder) return;
    const requestedContext = activeContextRef.current;
    const root = messageListRef.current;
    const oldHeight = root?.scrollHeight ?? 0;
    const oldTop = root?.scrollTop ?? 0;
    setLoadingOlder(true);
    setHistoryError(null);
    try {
      const page = await api.listChatMessages(selectedChatId, {
        before: messages[0].sequence,
        limit: 50
      });
      if (activeContextRef.current !== requestedContext) return;
      setMessages((current) => {
        const merged = new Map(
          page.messages.map((message) => [message.id, message])
        );
        for (const message of current) merged.set(message.id, message);
        return [...merged.values()].sort(
          (left, right) => left.sequence - right.sequence
        );
      });
      setOlderBefore(page.next_before);
      requestAnimationFrame(() => {
        if (activeContextRef.current === requestedContext && root)
          root.scrollTop = root.scrollHeight - oldHeight + oldTop;
      });
    } catch (error) {
      if (activeContextRef.current === requestedContext)
        setHistoryError(
          error instanceof Error
            ? error.message
            : "Older messages could not be loaded."
        );
    } finally {
      if (activeContextRef.current === requestedContext) setLoadingOlder(false);
    }
  };

  const setSelectedChat = (chatId?: string) => {
    void navigate({
      to: "/projects/$projectId/messages",
      params: { projectId },
      search: chatId ? { chat: chatId } : {}
    });
  };

  const handleScroll = () => {
    const element = messageListRef.current;
    if (!element) return;
    wasAtBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 64;
  };

  const chatMembers = selectedChat?.participants ?? [];
  const availableMentions = chatMembers.filter(
    (participant) =>
      participant.type !== "human" || participant.id !== profile.data?.user_id
  );
  // An archived project or branch keeps its conversations readable only.
  const canCompose = !readOnly && Boolean(selectedChat?.is_participant);
  const canManageMembers =
    !readOnly && selectedChat?.kind === "group" && selectedChat.can_manage;
  const selectedTitle = selectedChat
    ? chatTitle(selectedChat, currentUserId)
    : "";
  const chatGroups = chatSections
    .map((section) => ({
      ...section,
      chats: visibleChats.filter((chat) => chatSection(chat) === section.id)
    }))
    .filter((section) => section.chats.length > 0);
  const sharedDocuments = useMemo(() => {
    const unique = new Map<string, ChatMessage["documents"][number]>();
    for (const message of messages)
      for (const document of message.documents)
        unique.set(document.id, document);
    return [...unique.values()];
  }, [messages]);

  // Capture the read position once per conversation so the divider stays put while messages are acknowledged.
  const unreadMarkerRef = useRef<number | null>(null);
  if (unreadMarkerRef.current === null && selectedChat?.is_participant)
    unreadMarkerRef.current = selectedChat.last_read_sequence;
  const unreadMarker = unreadMarkerRef.current;
  const firstUnreadIndex =
    unreadMarker === null
      ? -1
      : messages.findIndex(({ sequence }) => sequence > unreadMarker);
  const showUnreadDivider =
    firstUnreadIndex > 0 &&
    !(
      messages[firstUnreadIndex]?.author.type === "human" &&
      messages[firstUnreadIndex]?.author.id === currentUserId
    );

  const isSelf = (participant: ParticipantRef) =>
    participant.type === "human" && participant.id === currentUserId;
  const memberSummary = (chat: Chat) => {
    const people = chat.participants.filter(
      ({ type }) => type === "human"
    ).length;
    const agents = chat.participants.length - people;
    const parts = [
      people ? `${people} ${people === 1 ? "person" : "people"}` : null,
      agents ? `${agents} ${agents === 1 ? "agent" : "agents"}` : null
    ].filter(Boolean);
    return parts.join(" and ") || "No participants";
  };
  const chatSubtitle = (chat: Chat) => {
    if (chat.kind === "group" || !chat.is_participant)
      return memberSummary(chat);
    const other = chat.participants.find((participant) => !isSelf(participant));
    return other?.type === "agent" ? "Agent" : "Direct message";
  };
  const chatPreview = (chat: Chat) =>
    chat.kind === "direct" && chat.is_participant
      ? chatSubtitle(chat)
      : chat.participants
          .filter((participant) => !isSelf(participant))
          .map(({ name }) => name)
          .join(", ") || "No participants";

  const openCreate = () => {
    setCreateError(null);
    setCreateAttempt(null);
    setCreateOpen(true);
    void candidatesQuery.refetch();
  };
  const openMemberPicker = () => {
    setDetailsOpen(true);
    if (canManageMembers) void candidatesQuery.refetch();
  };
  const toggleDetails = () => {
    if (detailsOpen) setDetailsOpen(false);
    else openMemberPicker();
  };
  const createPeople = filteredCandidates.filter(
    ({ type }) => type === "human"
  );
  const createAgents = filteredCandidates.filter(
    ({ type }) => type === "agent"
  );

  return (
    <Dialog open={createOpen} onOpenChange={setCreateOpen}>
      {!readOnly ? (
        <TopToolbarActions>
          <Button onClick={openCreate}>
            <SquarePen data-icon="inline-start" />
            New message
          </Button>
        </TopToolbarActions>
      ) : null}
      <div className="relative flex h-full min-h-[32rem] overflow-hidden">
        <aside
          className={cn(
            selectedChatId ? "hidden md:flex" : "flex",
            "min-h-0 w-full flex-col border-r md:w-[19.5rem] md:shrink-0"
          )}
          aria-label="Conversations"
        >
          <div className="p-3">
            <Input
              type="search"
              placeholder="Search conversations"
              aria-label="Search conversations"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {chatsQuery.isPending ? (
              <div role="status" className="flex flex-col gap-2 px-1">
                <span className="sr-only">Loading chats…</span>
                {[0, 1, 2, 3].map((item) => (
                  <Skeleton key={item} className="h-12 rounded-lg" />
                ))}
              </div>
            ) : null}
            {chatsQuery.isError ? (
              <div className="p-3 text-sm text-destructive" role="alert">
                Chats could not be loaded.{" "}
                <button
                  className="underline"
                  onClick={() => void chatsQuery.refetch()}
                >
                  Retry
                </button>
              </div>
            ) : null}
            {chatsQuery.isSuccess && visibleChats.length === 0 ? (
              <div className="px-3 py-10 text-center">
                <p className="text-sm font-medium">
                  {search.trim()
                    ? "No matching conversations"
                    : "No conversations yet"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {search.trim()
                    ? "Try another name or clear the search."
                    : "Start a direct message or group chat with a project member or agent."}
                </p>
                {!search.trim() && !readOnly ? (
                  <Button
                    className="mt-4"
                    variant="outline"
                    onClick={openCreate}
                  >
                    Start a conversation
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-col gap-3">
              {chatGroups.map((group) => (
                <section key={group.id} aria-label={group.title}>
                  <h2 className="flex h-7 items-center justify-between px-2 text-xs font-medium text-muted-foreground">
                    <span>{group.title}</span>
                    <span>{group.chats.length}</span>
                  </h2>
                  <ul className="flex flex-col gap-px">
                    {group.chats.map((chat) => {
                      const title = chatTitle(chat, currentUserId);
                      const selected = selectedChatId === chat.id;
                      const unread = chat.unread_count > 0;
                      return (
                        <li key={chat.id}>
                          <button
                            type="button"
                            onClick={() => setSelectedChat(chat.id)}
                            aria-current={selected ? "page" : undefined}
                            className={cn(
                              "flex w-full items-center gap-2.5 rounded-md p-2 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                              selected &&
                                "bg-sidebar-accent hover:bg-sidebar-accent"
                            )}
                          >
                            <ChatAvatar
                              chat={chat}
                              currentUserId={currentUserId}
                            />
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="flex items-baseline gap-1.5">
                                <span
                                  className={cn(
                                    "min-w-0 flex-1 truncate text-sm",
                                    unread ? "font-semibold" : "font-normal"
                                  )}
                                >
                                  {title}
                                </span>
                                <time
                                  className="shrink-0 text-xs text-muted-foreground"
                                  dateTime={chat.updated_at}
                                >
                                  {listTime(chat.updated_at)}
                                </time>
                              </span>
                              <span className="flex items-center gap-1.5">
                                <span
                                  className={cn(
                                    "min-w-0 flex-1 truncate text-xs",
                                    unread
                                      ? "text-foreground"
                                      : "text-muted-foreground"
                                  )}
                                >
                                  {chatPreview(chat)}
                                </span>
                                {chat.mention_count > 0 ? (
                                  <span
                                    className="inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-full bg-highlight px-1.5 text-[11px] font-semibold text-highlight-foreground"
                                    aria-label={`${chat.mention_count} mentions`}
                                  >
                                    <AtSign
                                      className="size-3"
                                      aria-hidden="true"
                                    />
                                    {chat.mention_count}
                                  </span>
                                ) : null}
                                {unread ? (
                                  <span
                                    className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground"
                                    aria-label={`${chat.unread_count} unread`}
                                  >
                                    {chat.unread_count}
                                  </span>
                                ) : null}
                                {!chat.is_participant ? (
                                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                                    <Eye
                                      className="size-3"
                                      aria-hidden="true"
                                    />
                                    Observer
                                  </span>
                                ) : null}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </aside>

        <section
          className={cn(
            selectedChatId ? "flex" : "hidden md:flex",
            "min-h-0 min-w-0 flex-1 flex-col"
          )}
          aria-label="Chat"
        >
          {!selectedChatId ? (
            <div className="m-auto max-w-sm px-8 text-center">
              <h2 className="text-sm font-medium">Select a conversation</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Choose a conversation from the list, or select New message to
                start one.
              </p>
            </div>
          ) : !selectedChat && elsewhereBranchId ? (
            <div className="m-auto px-6">
              <OtherBranchNotice
                item="conversation"
                branchId={elsewhereBranchId}
                onSwitch={() =>
                  void navigate({
                    to: "/projects/$projectId/messages",
                    params: { projectId },
                    search: {
                      chat: selectedChatId,
                      branch: branchParam(elsewhereBranchId)
                    }
                  })
                }
              />
            </div>
          ) : !selectedChat ? (
            <div
              className="m-auto px-6 text-center"
              role={
                chatsQuery.isError || historyAccessDenied ? "alert" : "status"
              }
            >
              <p className="text-sm font-medium">
                {historyAccessDenied
                  ? "You no longer have access to this conversation."
                  : chatsQuery.isPending
                    ? "Loading conversation…"
                    : "This chat is unavailable."}
              </p>
              {!chatsQuery.isPending ? (
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => setSelectedChat()}
                >
                  Back to chats
                </Button>
              ) : null}
            </div>
          ) : (
            <>
              <header className="flex h-14 shrink-0 items-center gap-2 border-b pl-2 pr-3 md:pl-5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="md:hidden"
                  aria-label="Back to chats"
                  onClick={() => setSelectedChat()}
                >
                  <ArrowLeft aria-hidden="true" />
                </Button>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <h2 className="truncate text-base font-semibold leading-snug">
                      {selectedTitle}
                    </h2>
                    {!selectedChat.is_participant ? (
                      <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-secondary px-2 text-xs font-medium text-muted-foreground">
                        <Eye className="size-3" aria-hidden="true" />
                        Observing
                      </span>
                    ) : null}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {chatSubtitle(selectedChat)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  aria-label={`Members, ${chatMembers.length}`}
                  onClick={openMemberPicker}
                >
                  <Users data-icon="inline-start" aria-hidden="true" />
                  {chatMembers.length}
                </Button>
                <Button
                  variant={detailsOpen ? "secondary" : "ghost"}
                  size="icon"
                  aria-label="Conversation details"
                  aria-pressed={detailsOpen}
                  onClick={toggleDetails}
                >
                  <Info aria-hidden="true" className="opacity-50" />
                </Button>
              </header>

              <div
                ref={messageListRef}
                onScroll={handleScroll}
                className="flex min-h-0 flex-1 flex-col overflow-y-auto py-4"
                aria-label="Message history"
                aria-live="polite"
              >
                {hasOlder ? (
                  <div className="mb-4 text-center">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void loadOlder()}
                      disabled={loadingOlder}
                    >
                      {loadingOlder ? "Loading…" : "Load older messages"}
                    </Button>
                  </div>
                ) : null}
                {historyError ? (
                  <div className="mb-3 flex items-center justify-center gap-2 px-5 text-center text-xs text-destructive">
                    <p role="alert">{historyError}</p>
                    {!historySyncReady ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setHistoryError(null);
                          setHistoryRetryCount((current) => current + 1);
                        }}
                      >
                        Retry sync
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {messagesQuery.isPending ? (
                  <p
                    role="status"
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    Loading messages…
                  </p>
                ) : null}
                {messagesQuery.isError ? (
                  <div
                    role="alert"
                    className="py-8 text-center text-sm text-destructive"
                  >
                    {historyForbidden
                      ? "This chat is unavailable."
                      : "Messages could not be loaded."}
                    {!historyForbidden ? (
                      <button
                        className="ml-1 underline"
                        onClick={() => void messagesQuery.refetch()}
                      >
                        Retry
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {!messagesQuery.isPending &&
                !messagesQuery.isError &&
                !historyAccessDenied &&
                messages.length === 0 ? (
                  <div className="m-auto px-6 text-center">
                    <p className="text-sm font-medium">No messages yet</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {canCompose
                        ? `Send the first message to ${selectedTitle}.`
                        : "Messages appear here as participants reply."}
                    </p>
                  </div>
                ) : null}
                <ol className="mt-auto">
                  {!historyAccessDenied && !historyForbidden
                    ? messages.map((message, index) => {
                        const previous = messages[index - 1];
                        const newDay =
                          !previous ||
                          startOfDay(
                            new Date(previous.created_at)
                          ).getTime() !==
                            startOfDay(new Date(message.created_at)).getTime();
                        const unreadDivider =
                          showUnreadDivider && index === firstUnreadIndex;
                        const continued =
                          !newDay &&
                          !unreadDivider &&
                          previous?.author.type === message.author.type &&
                          previous.author.id === message.author.id &&
                          new Date(message.created_at).getTime() -
                            new Date(previous.created_at).getTime() <
                            GROUP_WINDOW_MS;
                        const author = withAvatar(
                          participantByKey.get(refKey(message.author)) ??
                            message.author
                        );
                        return (
                          <Fragment key={message.id}>
                            {newDay ? (
                              <li className="flex items-center gap-3 px-5 py-3">
                                <span className="h-px flex-1 bg-border" />
                                <span className="text-xs font-medium text-muted-foreground">
                                  {dayLabel(message.created_at)}
                                </span>
                                <span className="h-px flex-1 bg-border" />
                              </li>
                            ) : null}
                            {unreadDivider ? (
                              <li className="flex items-center gap-3 px-5 py-2">
                                <span className="h-px flex-1 bg-primary-text" />
                                <span className="text-xs font-semibold text-primary-text">
                                  New messages
                                </span>
                              </li>
                            ) : null}
                            <li
                              data-sequence={message.sequence}
                              className={cn(
                                "flex gap-3 px-5",
                                continued ? "py-0.5" : "pt-2 pb-0.5"
                              )}
                            >
                              {continued ? (
                                <span
                                  className="w-9 shrink-0"
                                  aria-hidden="true"
                                />
                              ) : (
                                <ParticipantAvatar
                                  participant={author}
                                  size="lg"
                                />
                              )}
                              <div className="min-w-0 max-w-3xl flex-1">
                                {continued ? (
                                  <span className="sr-only">
                                    {message.author.name},{" "}
                                    {timeFormat.format(
                                      new Date(message.created_at)
                                    )}
                                  </span>
                                ) : (
                                  <div className="flex items-baseline gap-2">
                                    <span className="text-sm font-semibold">
                                      {message.author.name}
                                    </span>
                                    {message.author.type === "agent" ? (
                                      <span className="inline-flex h-[18px] items-center self-center rounded-full bg-secondary px-1.5 text-[11px] font-medium text-muted-foreground">
                                        Agent
                                      </span>
                                    ) : null}
                                    <time
                                      className="text-xs text-muted-foreground"
                                      dateTime={message.created_at}
                                    >
                                      {timeFormat.format(
                                        new Date(message.created_at)
                                      )}
                                    </time>
                                  </div>
                                )}
                                <MarkdownContent
                                  content={message.body_markdown}
                                  empty=""
                                />
                                {message.mentions.length ? (
                                  <div className="mt-1.5 flex flex-wrap gap-1">
                                    {message.mentions.map((mention) => (
                                      <span
                                        key={refKey(mention)}
                                        className="rounded px-1 text-xs font-medium bg-highlight text-highlight-foreground"
                                      >
                                        @{mention.name}
                                      </span>
                                    ))}
                                  </div>
                                ) : null}
                                {message.documents.length ? (
                                  <div className="mt-2 flex flex-col gap-1.5">
                                    {message.documents.map((document) => (
                                      <Link
                                        key={document.id}
                                        to="/projects/$projectId/documents"
                                        params={{ projectId }}
                                        search={{ document: document.id }}
                                        className="flex w-full max-w-sm items-center gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-card-foreground transition-colors hover:bg-muted"
                                      >
                                        <span
                                          aria-hidden="true"
                                          className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                                        >
                                          <FileText className="size-4" />
                                        </span>
                                        <span className="flex min-w-0 flex-col">
                                          <span className="text-xs text-muted-foreground">
                                            Document
                                          </span>
                                          <span className="truncate font-mono text-xs">
                                            {document.path}
                                          </span>
                                        </span>
                                      </Link>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            </li>
                          </Fragment>
                        );
                      })
                    : null}
                </ol>
              </div>

              {canCompose ? (
                <footer className="px-3 pb-3 pt-1 md:px-5 md:pb-4">
                  <div className="rounded-lg border border-input bg-background transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
                    {draft.mentions.length || draft.documents.length ? (
                      <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
                        {draft.mentions.map((mention) => (
                          <span
                            key={refKey(mention)}
                            className="inline-flex items-center gap-1 rounded-full bg-highlight px-2 py-0.5 text-xs font-medium text-highlight-foreground"
                          >
                            @
                            {participantByKey.get(refKey(mention))?.name ??
                              "participant"}
                            <button
                              type="button"
                              className="rounded-full"
                              aria-label={`Remove ${participantByKey.get(refKey(mention))?.name ?? "mention"}`}
                              onClick={() =>
                                setDraft((value) => ({
                                  ...value,
                                  mentions: value.mentions.filter(
                                    (item) => refKey(item) !== refKey(mention)
                                  )
                                }))
                              }
                            >
                              <X className="size-3" />
                            </button>
                          </span>
                        ))}
                        {draft.documents.map((id) => {
                          const document = documents.find(
                            (item) => item.id === id
                          );
                          return document ? (
                            <span
                              key={id}
                              className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                            >
                              <FileText className="size-3" aria-hidden="true" />
                              <span className="font-mono">{document.path}</span>
                              <button
                                type="button"
                                className="rounded-full"
                                aria-label={`Remove ${document.path}`}
                                onClick={() =>
                                  setDraft((value) => ({
                                    ...value,
                                    documents: value.documents.filter(
                                      (item) => item !== id
                                    )
                                  }))
                                }
                              >
                                <X className="size-3" />
                              </button>
                            </span>
                          ) : null;
                        })}
                      </div>
                    ) : null}
                    <Textarea
                      aria-label="Write a message"
                      placeholder={`Message ${selectedTitle}`}
                      value={draft.body}
                      rows={1}
                      onChange={(event) =>
                        setDraft((value) => ({
                          ...value,
                          body: event.target.value
                        }))
                      }
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          beginSend();
                        }
                      }}
                      className="max-h-48 min-h-11 resize-none rounded-none border-0 bg-transparent px-3 pt-2.5 pb-1 focus-visible:ring-0 dark:bg-transparent"
                    />
                    <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
                      <div className="relative">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground"
                          aria-label="Mention"
                          aria-expanded={picker === "mention"}
                          onClick={() =>
                            setPicker(picker === "mention" ? null : "mention")
                          }
                          disabled={
                            selectedChat.kind !== "group" ||
                            !availableMentions.length
                          }
                        >
                          <AtSign aria-hidden="true" />
                        </Button>
                        {picker === "mention" ? (
                          <div className="absolute bottom-9 left-0 z-20 w-64 rounded-md bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10">
                            <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
                              Mention a participant
                            </p>
                            <ul className="max-h-48 overflow-auto">
                              {availableMentions.map((candidate) => (
                                <li key={refKey(candidate)}>
                                  <button
                                    type="button"
                                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                                    onClick={() => addMention(candidate)}
                                  >
                                    <ParticipantAvatar
                                      participant={candidate}
                                      size="sm"
                                    />
                                    <span className="min-w-0 flex-1 truncate">
                                      {candidate.name}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                      {candidate.type === "agent"
                                        ? "Agent"
                                        : "Human"}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                      <div className="relative">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground"
                          aria-label="Attach document"
                          aria-expanded={picker === "document"}
                          onClick={() =>
                            setPicker(picker === "document" ? null : "document")
                          }
                        >
                          <Paperclip aria-hidden="true" />
                        </Button>
                        {picker === "document" ? (
                          <div className="absolute bottom-9 left-0 z-20 w-72 rounded-md bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-foreground/10">
                            <Input
                              className="h-8"
                              placeholder="Find a project document"
                              aria-label="Find a project document"
                              value={draftDocumentSearch}
                              onChange={(event) =>
                                setDraftDocumentSearch(event.target.value)
                              }
                            />
                            <ul className="mt-1 max-h-48 overflow-auto">
                              {filteredDocuments.map((document) => (
                                <li key={document.id}>
                                  <button
                                    type="button"
                                    className="w-full truncate rounded-sm px-2 py-1.5 text-left font-mono text-xs hover:bg-accent"
                                    onClick={() => addDocument(document)}
                                  >
                                    {document.path}
                                  </button>
                                </li>
                              ))}
                            </ul>
                            {documents.length === 0 ? (
                              <p className="px-2 py-2 text-xs text-muted-foreground">
                                No project documents found.
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <span className="ml-auto hidden pr-2 text-xs text-muted-foreground sm:inline">
                        Enter to send · Shift+Enter for a new line
                      </span>
                      <Button
                        size="icon"
                        className="ml-auto sm:ml-0"
                        aria-label="Send"
                        onClick={() => beginSend()}
                        disabled={
                          sendMutation.isPending ||
                          Boolean(pendingMessage) ||
                          !draft.body.trim()
                        }
                      >
                        <Send aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                  {sendError ? (
                    <div
                      className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
                      role="alert"
                    >
                      <span className="text-destructive">{sendError}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => beginSend(true)}
                        disabled={sendMutation.isPending}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : null}
                </footer>
              ) : (
                <footer className="px-3 pb-3 pt-1 md:px-5 md:pb-4">
                  <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted px-3.5 py-3">
                    <Eye
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <p className="min-w-0 flex-1 text-sm">
                      {readOnly
                        ? branchArchived
                          ? "This branch is archived. Its conversations are read-only."
                          : "This project is archived. Its conversations are read-only."
                        : selectedChat.can_join
                          ? `You are viewing ${selectedChat.has_human ? "this conversation" : "a conversation between agents"}. Join to reply; its participants will see your messages.`
                          : "Read-only observer. You can read this conversation but not reply."}
                    </p>
                    {selectedChat.can_join && !readOnly ? (
                      <Button
                        onClick={() => joinMutation.mutate()}
                        disabled={joinMutation.isPending}
                      >
                        {joinMutation.isPending
                          ? "Joining…"
                          : "Join conversation"}
                      </Button>
                    ) : null}
                  </div>
                  {joinMutation.isError ? (
                    <p role="alert" className="mt-2 text-xs text-destructive">
                      {joinMutation.error.message}
                    </p>
                  ) : null}
                </footer>
              )}
            </>
          )}
        </section>

        {selectedChat ? (
          // Stays mounted so closing can animate; inert removes it from focus and assistive tech while hidden.
          <div
            inert={!detailsOpen}
            className={cn(
              "absolute inset-y-0 right-0 z-20 w-72 max-w-full transition-[width,translate] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none xl:static xl:z-auto xl:shrink-0 xl:translate-x-0 xl:overflow-hidden",
              detailsOpen ? "translate-x-0" : "translate-x-full xl:w-0"
            )}
          >
            <aside
              aria-label="Conversation details"
              className="flex h-full w-72 max-w-full flex-col border-l bg-background shadow-lg xl:shadow-none"
            >
              <div className="flex h-14 shrink-0 items-center border-b pl-4 pr-2">
                <h2 className="flex-1 text-sm font-semibold">Details</h2>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close details"
                  onClick={() => setDetailsOpen(false)}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="flex flex-col gap-0.5 border-b p-4">
                  <span className="text-xs text-muted-foreground">
                    {selectedChat.kind === "group"
                      ? "Group chat"
                      : selectedChat.has_human
                        ? "Direct message"
                        : "Agent conversation"}
                  </span>
                  <span className="text-base font-medium">{selectedTitle}</span>
                  <span className="text-xs text-muted-foreground">
                    Created{" "}
                    {shortDateFormat.format(new Date(selectedChat.created_at))}
                  </span>
                </div>
                <section
                  aria-label="Members"
                  className="flex flex-col gap-0.5 border-b px-2 py-3"
                >
                  <h3 className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">
                    Members · {chatMembers.length}
                  </h3>
                  <ul className="flex flex-col gap-0.5">
                    {chatMembers.map((participant) => {
                      const self = isSelf(participant);
                      const canLeave =
                        self && selectedChat.creator.type === "agent";
                      const creator =
                        refKey(selectedChat.creator) === refKey(participant);
                      return (
                        <li
                          key={refKey(participant)}
                          className="flex items-center gap-2.5 rounded-md px-2 py-1.5"
                        >
                          <ParticipantAvatar
                            participant={withAvatar(participant)}
                            size="sm"
                          />
                          <span className="flex min-w-0 flex-1 flex-col leading-tight">
                            <span className="truncate text-sm">
                              {participant.name}
                              {self ? " (you)" : ""}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {participant.type === "agent" ? "Agent" : "Human"}
                              {creator ? " · Creator" : ""}
                            </span>
                          </span>
                          {canManageMembers && (!self || canLeave) ? (
                            <Button
                              variant="ghost"
                              size="xs"
                              aria-label={`${canLeave ? "Leave" : "Remove"} ${participant.name}`}
                              disabled={memberMutation.isPending}
                              onClick={() =>
                                memberMutation.mutate({
                                  action: "remove",
                                  participant
                                })
                              }
                            >
                              {canLeave ? "Leave" : "Remove"}
                            </Button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  {canManageMembers ? (
                    <div className="mt-2 flex flex-col gap-1 px-2">
                      <Input
                        className="h-8"
                        placeholder="Add a project member"
                        aria-label="Find project member to add"
                        value={manageSearch}
                        onChange={(event) =>
                          setManageSearch(event.target.value)
                        }
                      />
                      {manageSearch.trim() ? (
                        <ul className="flex max-h-40 flex-col gap-0.5 overflow-auto">
                          {filteredManageCandidates.map((participant) => (
                            <li key={refKey(participant)}>
                              <button
                                type="button"
                                aria-label={`Add ${participant.name}`}
                                className="flex w-full items-center gap-2 rounded-sm px-1.5 py-1.5 text-left text-sm hover:bg-accent"
                                disabled={memberMutation.isPending}
                                onClick={() =>
                                  memberMutation.mutate({
                                    action: "add",
                                    participant
                                  })
                                }
                              >
                                <Plus
                                  className="size-3.5 text-muted-foreground"
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 truncate">
                                  {participant.name}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {participant.type === "agent"
                                    ? "Agent"
                                    : "Human"}
                                </span>
                              </button>
                            </li>
                          ))}
                          {filteredManageCandidates.length === 0 ? (
                            <li className="px-1.5 py-1.5 text-xs text-muted-foreground">
                              No matching project members.
                            </li>
                          ) : null}
                        </ul>
                      ) : null}
                    </div>
                  ) : selectedChat.kind === "direct" ? (
                    <p className="px-2 pt-1.5 text-xs text-muted-foreground">
                      Direct message membership is fixed.
                    </p>
                  ) : null}
                  {memberMutation.isError ? (
                    <p
                      role="alert"
                      className="px-2 pt-2 text-xs text-destructive"
                    >
                      {memberMutation.error.message}
                    </p>
                  ) : null}
                </section>
                <section
                  aria-label="Shared documents"
                  className="flex flex-col gap-0.5 px-2 py-3"
                >
                  <h3 className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">
                    Shared documents
                  </h3>
                  {sharedDocuments.map((document) => (
                    <Link
                      key={document.id}
                      to="/projects/$projectId/documents"
                      params={{ projectId }}
                      search={{ document: document.id }}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
                    >
                      <FileText
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="truncate font-mono text-xs">
                        {document.path}
                      </span>
                    </Link>
                  ))}
                  {sharedDocuments.length === 0 ? (
                    <p className="px-2 text-xs text-muted-foreground">
                      No documents shared yet.
                    </p>
                  ) : null}
                </section>
              </div>
            </aside>
          </div>
        ) : null}

        <DialogContent
          className="max-h-[min(85dvh,44rem)] w-[calc(100vw-2rem)] max-w-lg gap-0 overflow-auto p-0"
          showCloseButton={false}
        >
          <DialogHeader className="flex-row items-center justify-between gap-4 px-5 pt-4 pb-3">
            <div>
              <DialogTitle className="text-base">New message</DialogTitle>
              <DialogDescription className="mt-0.5">
                Message project members and agents.
              </DialogDescription>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close new message"
              onClick={() => setCreateOpen(false)}
            >
              <X aria-hidden="true" />
            </Button>
          </DialogHeader>
          <div className="flex flex-col gap-4 px-5">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="new-message-to" className="text-sm font-medium">
                To
              </label>
              <div className="flex min-h-10 flex-wrap items-center gap-1 rounded-lg border border-input px-1.5 py-1 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
                {createParticipants.map((participant) => {
                  const recipient = participantByKey.get(refKey(participant));
                  const name = recipient?.name ?? "Recipient";
                  return (
                    <span
                      key={refKey(participant)}
                      className="inline-flex h-7 items-center gap-1.5 rounded-full bg-muted pr-0.5 pl-1 text-sm"
                    >
                      {recipient ? (
                        <ParticipantAvatar participant={recipient} size="sm" />
                      ) : null}
                      {name}
                      <button
                        type="button"
                        className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
                        aria-label={`Remove ${name}`}
                        onClick={() => toggleParticipant(participant)}
                      >
                        <X className="size-3" aria-hidden="true" />
                      </button>
                    </span>
                  );
                })}
                <input
                  id="new-message-to"
                  className="h-7 min-w-24 flex-1 bg-transparent px-1.5 text-sm outline-none placeholder:text-muted-foreground"
                  placeholder={
                    createParticipants.length ? "" : "Search people and agents"
                  }
                  value={createSearch}
                  onChange={(event) => setCreateSearch(event.target.value)}
                  onKeyDown={(event) => {
                    const last = createParticipants.at(-1);
                    if (event.key === "Backspace" && !createSearch && last)
                      toggleParticipant(last);
                  }}
                />
              </div>
            </div>
            <ul
              aria-label="Project members"
              className="flex max-h-64 flex-col gap-px overflow-auto rounded-md p-1 ring-1 ring-foreground/10"
            >
              {candidatesQuery.isPending ? (
                <li className="p-3 text-sm text-muted-foreground" role="status">
                  Loading project members…
                </li>
              ) : null}
              {candidatesQuery.isError ? (
                <li role="alert" className="p-3 text-sm text-destructive">
                  Project members could not be loaded.{" "}
                  <button
                    className="underline"
                    onClick={() => void candidatesQuery.refetch()}
                  >
                    Retry
                  </button>
                </li>
              ) : null}
              {[
                { title: "People", items: createPeople },
                { title: "Agents", items: createAgents }
              ].map((group) =>
                group.items.length ? (
                  <li key={group.title}>
                    <p className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
                      {group.title}
                    </p>
                    <ul className="flex flex-col gap-px">
                      {group.items.map((candidate) => {
                        const selected = createParticipants.some(
                          (item) => refKey(item) === refKey(candidate)
                        );
                        return (
                          <li key={refKey(candidate)}>
                            <button
                              type="button"
                              aria-pressed={selected}
                              onClick={() => {
                                toggleParticipant(candidate);
                                setCreateSearch("");
                              }}
                              className={cn(
                                "flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left hover:bg-accent",
                                selected && "bg-accent"
                              )}
                            >
                              <ParticipantAvatar
                                participant={candidate}
                                size="sm"
                              />
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                {candidate.name}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {candidate.type === "agent" ? "Agent" : "Human"}
                              </span>
                              <Check
                                className={cn(
                                  "size-4 text-primary-text",
                                  !selected && "invisible"
                                )}
                                aria-hidden="true"
                              />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ) : null
              )}
              {candidatesQuery.isSuccess && filteredCandidates.length === 0 ? (
                <li className="p-3 text-sm text-muted-foreground">
                  No matching project members.
                </li>
              ) : null}
            </ul>
            {createKind === "group" ? (
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Group name
                <Input
                  value={createName}
                  maxLength={120}
                  required
                  onChange={(event) => setCreateName(event.target.value)}
                  placeholder="For example, Release planning"
                />
              </label>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {createParticipants.length === 0
                ? "One recipient starts a direct message. Two or more start a group chat."
                : createKind === "group"
                  ? "This starts a group chat. You’ll be added as a participant."
                  : "A direct message is shared only with its participants."}
            </p>
            {createError ? (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 px-3 py-2 text-sm text-destructive"
              >
                <span>{createError}</span>
                {createAttempt ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => submitCreate(true)}
                    disabled={createMutation.isPending}
                  >
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="mt-5 flex items-center justify-end gap-2 border-t bg-muted/50 px-5 py-3">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => submitCreate()}
              disabled={
                createMutation.isPending ||
                createParticipants.length < 1 ||
                (createKind === "group" && !createName.trim())
              }
            >
              {createMutation.isPending
                ? "Creating…"
                : createKind === "group"
                  ? "Create group"
                  : "Start conversation"}
            </Button>
          </div>
        </DialogContent>
      </div>
    </Dialog>
  );
}
