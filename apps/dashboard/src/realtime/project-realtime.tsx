import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  realtimeEventEnvelopeSchema,
  type AgentsResponse,
  type Branch,
  type ProjectEvent,
  type RealtimeEventEnvelope,
  type Task
} from "@orchestrat/protocol";
import type { Chat } from "@orchestrat/protocol";
import type { ApiClient } from "@/lib/api/client";
import { DashboardApiError } from "@/lib/api/client";
import {
  invalidateCoordinationQueries,
  invalidateRealtimeEvent
} from "@/features/coordination/query-options";
import { coordinationKeys } from "@/features/coordination/query-options";
import { messagingKeys } from "@/features/messaging/query-options";
import { hierarchyKeys } from "@/features/hierarchy/query-options";
import { attentionKeys } from "@/features/attention/query-options";
import { branchKeys } from "@/features/branches/query-options";
import type { NativeNotification, Platform } from "@/platform/contract";

export type RealtimeStatus = "connecting" | "connected" | "disconnected";
type ReplayedChatMessage = {
  eventId: number;
  chatId: string;
  actorUserId: string | null;
};
export type SocketLike = Pick<WebSocket, "close" | "send"> & {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
};
export type SocketFactory = (url: string) => SocketLike;

const defaultSocket: SocketFactory = (url) => new WebSocket(url);
const MAX_RECONNECT_MS = 30_000;
const notificationEventTypes = new Set([
  "run.failed",
  "claim.completed",
  "claim.expired",
  "task.moved",
  "task.comment_created",
  "task.status_changed"
]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Every cached chat list of a project, one per branch viewed. */
function cachedChatLists(queryClient: QueryClient, projectId: string) {
  return queryClient.getQueriesData<{ chats: Chat[] }>({
    queryKey: messagingKeys.chats(projectId)
  });
}

function evictProjectMessagingCaches(
  queryClient: QueryClient,
  projectId: string
) {
  for (const [, cached] of cachedChatLists(queryClient, projectId))
    for (const chat of cached?.chats ?? []) {
      queryClient.removeQueries({ queryKey: messagingKeys.chat(chat.id) });
      queryClient.removeQueries({ queryKey: messagingKeys.messages(chat.id) });
    }
  queryClient.removeQueries({ queryKey: messagingKeys.chats(projectId) });
  queryClient.removeQueries({ queryKey: messagingKeys.candidates(projectId) });
  queryClient.removeQueries({ queryKey: messagingKeys.inbox(projectId) });
}

function evictChatCache(
  queryClient: QueryClient,
  projectId: string,
  chatId: string
) {
  queryClient.removeQueries({ queryKey: messagingKeys.chat(chatId) });
  queryClient.removeQueries({ queryKey: messagingKeys.messages(chatId) });
  queryClient.setQueriesData<{ chats: Chat[] }>(
    { queryKey: messagingKeys.chats(projectId) },
    (current) =>
      current && {
        ...current,
        chats: current.chats.filter((chat) => chat.id !== chatId)
      }
  );
  void queryClient.invalidateQueries({
    queryKey: messagingKeys.inbox(projectId)
  });
}

type ChatNotice = {
  id: string;
  projectId: string;
  chatId: string;
  /** The chat's branch, when it isn't the one on screen (spec §11.4). */
  branchId?: string;
  /** Lets a handoff notice replace the plain notice for the same message. */
  messageId?: string;
  title: string;
  body: string;
  mentioned: boolean;
};

/** What a task.status_changed notification needs from its durable event. */
export type TaskStatusChangeNotice = {
  toStatus: string;
  taskId: string;
  taskKey: string;
  agentName?: string;
};

function notificationBody(value: string) {
  const normalized = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (
    [...normalized].slice(0, 240).join("").trim() || "Task status changed."
  );
}

export function isHumanMentionedInTaskComment(
  event: RealtimeEventEnvelope,
  currentUserId: string | undefined
) {
  return Boolean(
    currentUserId &&
    event.event_type === "task.comment_created" &&
    !(event.actor?.type === "human" && event.actor.id === currentUserId) &&
    event.mentions?.some(
      (participant) =>
        participant.type === "human" && participant.id === currentUserId
    )
  );
}

export function notificationForRealtimeEvent(
  event: RealtimeEventEnvelope,
  task?: Pick<Task, "status" | "title">,
  claimTaskId?: string,
  currentUserId?: string,
  statusChange?: TaskStatusChangeNotice
): NativeNotification | null {
  const notification = baseNotificationForRealtimeEvent(
    event,
    task,
    claimTaskId,
    currentUserId,
    statusChange
  );
  // A click opens the branch the event happened on (spec §11.1).
  return notification && event.branch_id
    ? {
        ...notification,
        destination: { ...notification.destination, branchId: event.branch_id }
      }
    : notification;
}

function baseNotificationForRealtimeEvent(
  event: RealtimeEventEnvelope,
  task?: Pick<Task, "status" | "title">,
  claimTaskId?: string,
  currentUserId?: string,
  statusChange?: TaskStatusChangeNotice
): NativeNotification | null {
  // Agents set blocked and review themselves (spec §14); other transitions,
  // including system block resolutions, stay quiet.
  if (event.event_type === "task.status_changed") {
    if (
      !statusChange ||
      (event.actor?.type === "human" && event.actor.id === currentUserId)
    )
      return null;
    const destination = {
      kind: "task" as const,
      projectId: event.project_id,
      taskId: statusChange.taskId
    };
    if (statusChange.toStatus === "blocked")
      return {
        title: "Agent blocked",
        body: notificationBody(
          `${statusChange.agentName ?? "An agent"} is blocked on ${statusChange.taskKey}`
        ),
        destination
      };
    if (statusChange.toStatus === "review")
      return {
        title: "Ready for review",
        body: notificationBody(`${statusChange.taskKey} is ready for review`),
        destination
      };
    return null;
  }
  // task.comment_created is keyed by the comment; the task id comes from the
  // durable event payload (claimTaskId).
  if (event.event_type === "task.comment_created")
    return isHumanMentionedInTaskComment(event, currentUserId)
      ? {
          title: "You were mentioned",
          body: `${event.actor?.type === "agent" ? "An agent" : "A teammate"} mentioned you in a task comment.`,
          destination: claimTaskId
            ? { kind: "task", projectId: event.project_id, taskId: claimTaskId }
            : { kind: "activity", projectId: event.project_id }
        }
      : null;
  if (event.event_type === "run.failed")
    return {
      title: "Agent run failed",
      body: "An agent run failed.",
      destination: { kind: "activity", projectId: event.project_id }
    };
  if (event.event_type === "claim.completed")
    return {
      title: "Task completed",
      body: "An agent completed a task.",
      destination: claimTaskId
        ? { kind: "task", projectId: event.project_id, taskId: claimTaskId }
        : { kind: "activity", projectId: event.project_id }
    };
  if (event.event_type === "claim.expired")
    return {
      title: "Claim expired",
      body: "An agent claim expired.",
      destination: claimTaskId
        ? { kind: "task", projectId: event.project_id, taskId: claimTaskId }
        : { kind: "activity", projectId: event.project_id }
    };
  if (
    event.entity_type === "task" &&
    event.entity_id &&
    task?.status === "done"
  )
    return {
      title: "Task completed",
      body: notificationBody(task.title),
      destination: {
        kind: "task",
        projectId: event.project_id,
        taskId: event.entity_id
      }
    };
  if (
    event.entity_type === "task" &&
    event.entity_id &&
    task?.status === "blocked"
  )
    return {
      title: "Agent blocked",
      body: notificationBody(task.title),
      destination: {
        kind: "task",
        projectId: event.project_id,
        taskId: event.entity_id
      }
    };
  return null;
}

export class ProjectRealtimeController {
  private socket: SocketLike | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSequence = 0;
  private catchUpSocket: SocketLike | null = null;
  private buffered: RealtimeEventEnvelope[] = [];
  private lastNotifiedSequence = 0;
  private notificationQueue = Promise.resolve();
  private connectedBefore = false;
  private lifecycleToken = 0;
  private status: RealtimeStatus = "disconnected";
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: Pick<
      ApiClient,
      | "createRealtimeTicket"
      | "realtimeSocketUrl"
      | "listProjectEvents"
      | "getTask"
      | "listChats"
    > &
      Partial<Pick<ApiClient, "listAgents">>,
    private readonly queryClient: QueryClient,
    private readonly projectId: string,
    private readonly socketFactory: SocketFactory = defaultSocket,
    private readonly random = Math.random,
    private readonly platform?: Pick<
      Platform,
      "kind" | "notify" | "isBackgrounded"
    >,
    private readonly isBackgrounded: () => boolean | Promise<boolean> = () =>
      this.platform?.isBackgrounded?.() ??
      Promise.resolve(
        typeof document !== "undefined" && document.visibilityState === "hidden"
      ),
    private readonly onChatEvent?: (
      event: RealtimeEventEnvelope,
      isCurrent: () => boolean
    ) => void | Promise<void>,
    private readonly onReconnectSummary?: (
      missedMessages: ReplayedChatMessage[],
      isCurrent: () => boolean
    ) => void | Promise<void>,
    private readonly currentUserId: () => string | undefined = () => undefined
  ) {}

  getStatus = () => this.status;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start() {
    this.stopped = false;
    this.connect();
    return () => this.stop();
  }

  stop() {
    this.lifecycleToken += 1;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.catchUpSocket = null;
    this.buffered = [];
    this.socket?.close();
    this.socket = null;
    this.setStatus("disconnected");
  }

  private setStatus(status: RealtimeStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.listeners) listener();
  }

  private async connect() {
    if (this.stopped) return;
    this.setStatus("connecting");
    try {
      const ticket = await this.api.createRealtimeTicket(this.projectId);
      if (this.stopped) return;
      const socket = this.socketFactory(
        this.api.realtimeSocketUrl(this.projectId, ticket.ticket)
      );
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        this.catchUpSocket = socket;
        void this.catchUp(socket);
      };
      socket.onmessage = (event) => this.receive(socket, event.data);
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (this.catchUpSocket === socket) {
          this.catchUpSocket = null;
          this.buffered = [];
        }
        this.setStatus("disconnected");
        this.scheduleReconnect();
      };
    } catch (error) {
      if (error instanceof DashboardApiError && error.status === 403) {
        this.revokeProjectAccess();
        return;
      }
      this.setStatus("disconnected");
      this.scheduleReconnect();
    }
  }

  private async catchUp(socket: SocketLike) {
    if (this.socket !== socket || this.catchUpSocket !== socket) return;
    let succeeded = false;
    const missedChatMessages: ReplayedChatMessage[] = [];
    try {
      let after = this.lastSequence ? String(this.lastSequence) : undefined;
      let nextSequence = this.lastSequence;
      let events;
      do {
        // One monotonic cursor over every branch (spec §11.4).
        events = await this.api.listProjectEvents(
          this.projectId,
          { after },
          { allBranches: true }
        );
        for (const event of events.events) {
          nextSequence = Math.max(nextSequence, event.id);
          if (event.type === "chat.message_created" && event.entity_id)
            missedChatMessages.push({
              eventId: event.id,
              chatId: event.entity_id,
              actorUserId: event.actor_user_id
            });
        }
        after = events.next_cursor ?? undefined;
      } while (events.next_cursor !== null);
      if (this.socket !== socket || this.catchUpSocket !== socket) return;
      if (!(await this.refreshMessageAccess(socket))) return;
      const participantChatIds = new Set(
        cachedChatLists(this.queryClient, this.projectId)
          .flatMap(([, cached]) => cached?.chats ?? [])
          .filter((chat) => chat.is_participant)
          .map((chat) => chat.id)
      );
      const authorizedMissedChatMessages = missedChatMessages.filter(
        ({ chatId }) => participantChatIds.has(chatId)
      );
      await invalidateCoordinationQueries(this.queryClient, this.projectId);
      if (
        this.socket !== socket ||
        this.catchUpSocket !== socket ||
        this.stopped
      )
        return;
      this.lastSequence = nextSequence;
      if (this.connectedBefore && authorizedMissedChatMessages.length > 0)
        void Promise.resolve(
          this.onReconnectSummary?.(
            authorizedMissedChatMessages,
            () => this.socket === socket && !this.stopped
          )
        ).catch(() => undefined);
      this.connectedBefore = true;
      succeeded = true;
    } catch (error) {
      if (error instanceof DashboardApiError && error.status === 403) {
        this.revokeProjectAccess();
        return;
      }
      if (this.socket === socket && this.catchUpSocket === socket)
        await invalidateCoordinationQueries(this.queryClient, this.projectId);
    } finally {
      if (this.socket === socket && this.catchUpSocket === socket) {
        this.catchUpSocket = null;
        if (!succeeded) {
          this.buffered = [];
          socket.close();
        } else if (!this.stopped) {
          this.reconnectAttempt = 0;
          this.setStatus("connected");
          for (const event of this.buffered.splice(0)) this.handle(event);
        }
      }
    }
  }

  private receive(socket: SocketLike, data: unknown) {
    if (this.socket !== socket) return;
    let parsed: unknown;
    try {
      parsed = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      void invalidateCoordinationQueries(this.queryClient, this.projectId);
      return;
    }
    const result = realtimeEventEnvelopeSchema.safeParse(parsed);
    if (!result.success || result.data.project_id !== this.projectId) {
      void invalidateCoordinationQueries(this.queryClient, this.projectId);
      return;
    }
    if (this.catchUpSocket === socket) this.buffered.push(result.data);
    else this.handle(result.data);
  }

  private handle(event: RealtimeEventEnvelope) {
    if (event.sequence <= this.lastSequence) return;
    this.lastSequence = event.sequence;
    void invalidateRealtimeEvent(this.queryClient, this.projectId, event);
    if (event.entity_type === "chat") {
      const lifecycleToken = this.lifecycleToken;
      void Promise.resolve(
        this.onChatEvent?.(
          event,
          () => !this.stopped && this.lifecycleToken === lifecycleToken
        )
      ).catch(() => undefined);
      return;
    }
    if (!notificationEventTypes.has(event.event_type)) return;
    if (
      event.event_type === "task.comment_created" &&
      !isHumanMentionedInTaskComment(event, this.currentUserId())
    )
      return;
    this.notificationQueue = this.notificationQueue.then(() =>
      this.notifyForEvent(event)
    );
  }

  private revokeProjectAccess() {
    this.stop();
    evictProjectMessagingCaches(this.queryClient, this.projectId);
    this.queryClient.removeQueries({
      queryKey: coordinationKeys.all,
      predicate: ({ queryKey }) => queryKey.includes(this.projectId)
    });
    this.queryClient.removeQueries({
      queryKey: attentionKeys.project(this.projectId)
    });
    void this.queryClient.invalidateQueries({
      queryKey: hierarchyKeys.catalog()
    });
  }

  private async refreshMessageAccess(socket: SocketLike) {
    if (this.socket !== socket || this.catchUpSocket !== socket || this.stopped)
      return false;
    // Each branch viewed has its own cached list; refresh every one, or the
    // default branch's when none is cached yet.
    const cached = cachedChatLists(this.queryClient, this.projectId);
    const lists = cached.length
      ? cached
      : [[messagingKeys.chats(this.projectId), undefined] as const];
    const refreshedLists = await Promise.all(
      lists.map(async ([key, previous]) => {
        const branchId = key[3] as string | undefined;
        return {
          key,
          previous,
          refreshed: await this.api.listChats(this.projectId, { branchId })
        };
      })
    );
    if (this.socket !== socket || this.catchUpSocket !== socket || this.stopped)
      return false;
    const visible = new Set(
      refreshedLists.flatMap(({ refreshed }) =>
        refreshed.chats.map(({ id }) => id)
      )
    );
    for (const { key, previous, refreshed } of refreshedLists) {
      this.queryClient.setQueryData(key, refreshed);
      for (const chat of previous?.chats ?? []) {
        if (visible.has(chat.id)) continue;
        this.queryClient.removeQueries({
          queryKey: messagingKeys.chat(chat.id)
        });
        this.queryClient.removeQueries({
          queryKey: messagingKeys.messages(chat.id)
        });
      }
    }
    await Promise.all(
      [...visible].map((id) =>
        this.queryClient.invalidateQueries({
          queryKey: messagingKeys.messages(id)
        })
      )
    );
    return (
      this.socket === socket && this.catchUpSocket === socket && !this.stopped
    );
  }

  private async notifyForEvent(event: RealtimeEventEnvelope) {
    try {
      if (
        this.stopped ||
        this.platform?.kind !== "desktop" ||
        !this.platform.notify ||
        event.sequence <= this.lastNotifiedSequence
      )
        return;
      if (!(await this.isBackgrounded()) || this.stopped) return;
      let task: Pick<Task, "status" | "title"> | undefined;
      let claimTaskId: string | undefined;
      let statusChange: TaskStatusChangeNotice | undefined;
      let resolvedTarget = false;
      if (
        event.entity_type === "task" &&
        event.entity_id &&
        event.event_type === "task.moved"
      ) {
        task = await this.api.getTask(event.entity_id);
        resolvedTarget = true;
      }
      const userId = this.currentUserId();
      if (event.event_type === "task.status_changed") {
        if (event.actor?.type === "human" && event.actor.id === userId) return;
        statusChange = await this.statusChange(event);
        if (!statusChange) return;
        resolvedTarget = true;
      }
      if (
        event.event_type === "claim.completed" ||
        event.event_type === "claim.expired" ||
        event.event_type === "task.comment_created"
      ) {
        claimTaskId = await this.claimTaskId(event);
        resolvedTarget = true;
      }
      if (resolvedTarget && (!(await this.isBackgrounded()) || this.stopped))
        return;
      const notification = notificationForRealtimeEvent(
        event,
        task,
        claimTaskId,
        userId,
        statusChange
      );
      if (!notification || this.stopped) return;
      this.lastNotifiedSequence = event.sequence;
      await this.platform.notify(notification);
    } catch {
      // Notifications are best effort and must never affect realtime processing.
    }
  }

  // Realtime envelopes carry no payload, so notifications that need one read
  // the durable event back by sequence.
  private async durableEvent(
    event: RealtimeEventEnvelope
  ): Promise<ProjectEvent | undefined> {
    const response = await this.api.listProjectEvents(
      this.projectId,
      {
        after: event.sequence > 1 ? String(event.sequence - 1) : undefined,
        limit: 1
      },
      { allBranches: true }
    );
    return response.events.find(
      (candidate) =>
        candidate.id === event.sequence && candidate.type === event.event_type
    );
  }

  private async claimTaskId(event: RealtimeEventEnvelope) {
    try {
      const taskId = (await this.durableEvent(event))?.payload.task_id;
      return typeof taskId === "string" && uuidPattern.test(taskId)
        ? taskId
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async statusChange(
    event: RealtimeEventEnvelope
  ): Promise<TaskStatusChangeNotice | undefined> {
    try {
      const durable = await this.durableEvent(event);
      const toStatus = durable?.payload.to_status;
      if (toStatus !== "blocked" && toStatus !== "review") return undefined;
      const taskId =
        event.entity_id ??
        (typeof durable?.payload.task_id === "string"
          ? durable.payload.task_id
          : null);
      if (!taskId || !uuidPattern.test(taskId)) return undefined;
      const task = await this.api.getTask(taskId);
      const agentId =
        event.actor?.type === "agent"
          ? event.actor.id
          : durable?.actor_agent_id;
      return {
        toStatus,
        taskId,
        taskKey: task.key,
        agentName: agentId ? await this.agentName(agentId) : undefined
      };
    } catch {
      return undefined;
    }
  }

  private async agentName(agentId: string) {
    try {
      const cached = this.queryClient.getQueryData<AgentsResponse>(
        coordinationKeys.agents(this.projectId)
      );
      const agents =
        cached?.agents ??
        (await this.api.listAgents?.(this.projectId))?.agents ??
        [];
      return agents.find((agent) => agent.id === agentId)?.name;
    } catch {
      return undefined;
    }
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const base = Math.min(MAX_RECONNECT_MS, 500 * 2 ** this.reconnectAttempt++);
    const delay = Math.round(base * (0.8 + this.random() * 0.4));
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = null;
        void this.connect();
      },
      Math.min(MAX_RECONNECT_MS, delay)
    );
  }
}

const RealtimeContext = createContext<RealtimeStatus>("disconnected");

export function useProjectRealtimeStatus() {
  return useContext(RealtimeContext);
}

/** The branch a project's pages show: `?branch=`, or the default branch. */
function viewedBranchId(queryClient: QueryClient, projectId: string) {
  if (typeof window === "undefined") return undefined;
  const url = new URL(window.location.href);
  if (!url.pathname.startsWith(`/projects/${projectId}/`)) return undefined;
  return (
    url.searchParams.get("branch") ??
    queryClient
      .getQueryData<{ branches: Branch[] }>(branchKeys.list(projectId))
      ?.branches.find((branch) => branch.is_default)?.id
  );
}

async function currentChatIsVisible(
  chatId: string,
  platform: Platform,
  branchMatches = true
) {
  if (typeof window === "undefined" || document.visibilityState !== "visible")
    return false;
  const url = new URL(window.location.href);
  // Another branch's page shows a "switch" notice, not the chat.
  if (
    !branchMatches ||
    !url.pathname.endsWith("/messages") ||
    url.searchParams.get("chat") !== chatId
  )
    return false;
  if (platform.kind === "desktop" && platform.isBackgrounded)
    return !(await platform.isBackgrounded());
  return true;
}

function realtimeChatTitle(
  chat: Awaited<ReturnType<ApiClient["getChat"]>>,
  userId: string
) {
  if (chat.kind === "group") return chat.name ?? "Group chat";
  return (
    chat.participants.find(
      (participant) => participant.type !== "human" || participant.id !== userId
    )?.name ?? "direct message"
  );
}

export function ProjectRealtimeProvider({
  api,
  queryClient,
  projectIds,
  activeProjectId,
  currentUserId,
  platform,
  navigateToChat,
  children
}: {
  api: ApiClient;
  queryClient: QueryClient;
  projectIds: string[];
  activeProjectId: string;
  currentUserId?: string;
  platform: Platform;
  navigateToChat: (
    projectId: string,
    chatId: string,
    branchId?: string
  ) => void | Promise<void>;
  children: ReactNode;
}) {
  const [notices, setNotices] = useState<ChatNotice[]>([]);
  const mountedRef = useRef(false);
  const currentUserRef = useRef(currentUserId);
  const projectIdsRef = useRef(projectIds);
  const chatAccessGenerationRef = useRef(new Map<string, number>());
  currentUserRef.current = currentUserId;
  projectIdsRef.current = projectIds;
  const dismissNotice = useCallback((id: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);
  const addNotice = useCallback(
    (notice: ChatNotice, replacesMessage = false) => {
      setNotices((current) => {
        if (current.some(({ id }) => id === notice.id)) return current;
        const kept = replacesMessage
          ? current.filter(
              (item) =>
                item.projectId !== notice.projectId ||
                item.chatId !== notice.chatId ||
                item.messageId !== notice.messageId
            )
          : current;
        return [...kept, notice].slice(-6);
      });
    },
    []
  );
  const notifyChatEvent = useCallback(
    async (
      event: RealtimeEventEnvelope,
      isControllerCurrent: () => boolean
    ) => {
      const userId = currentUserRef.current;
      if (
        !mountedRef.current ||
        !isControllerCurrent() ||
        !userId ||
        !projectIdsRef.current.includes(event.project_id) ||
        !event.entity_id
      )
        return;
      const accessKey = `${event.project_id}:${event.entity_id}`;
      const getAccessGeneration = () =>
        chatAccessGenerationRef.current.get(accessKey) ?? 0;
      if (
        event.event_type === "chat.access_invalidated" ||
        (event.event_type === "chat.member_removed" &&
          event.affected_participant?.type === "human" &&
          event.affected_participant.id === userId)
      ) {
        chatAccessGenerationRef.current.set(
          accessKey,
          getAccessGeneration() + 1
        );
        evictChatCache(queryClient, event.project_id, event.entity_id);
        setNotices((current) =>
          current.filter(
            (notice) =>
              notice.chatId !== event.entity_id ||
              notice.projectId !== event.project_id
          )
        );
        return;
      }
      const isMessage = event.event_type === "chat.message_created";
      const isCreated = event.event_type === "chat.created";
      const isAdded =
        event.event_type === "chat.member_added" &&
        event.affected_participant?.type === "human" &&
        event.affected_participant.id === userId;
      // A handoff arrives as a direct message first; its notice replaces the
      // plain message notice for the same message.
      const isHandoff =
        event.event_type === "chat.handoff_created" &&
        event.affected_participant?.type === "human" &&
        event.affected_participant.id === userId;
      if (!isMessage && !isCreated && !isAdded && !isHandoff) return;
      if (event.actor?.type === "human" && event.actor.id === userId) return;
      const accessGeneration = getAccessGeneration();
      const chat = await api.getChat(event.entity_id);
      if (
        !mountedRef.current ||
        !isControllerCurrent() ||
        getAccessGeneration() !== accessGeneration
      )
        return;
      const chatBranchId = chat.branch_id ?? event.branch_id ?? undefined;
      const viewed = viewedBranchId(queryClient, event.project_id);
      const otherBranch =
        chatBranchId && viewed && chatBranchId !== viewed
          ? queryClient
              .getQueryData<{
                branches: Branch[];
              }>(branchKeys.list(event.project_id))
              ?.branches.find((branch) => branch.id === chatBranchId)?.name
          : undefined;
      const visible = await currentChatIsVisible(
        chat.id,
        platform,
        !chatBranchId || !viewed || chatBranchId === viewed
      );
      if (
        !mountedRef.current ||
        !isControllerCurrent() ||
        getAccessGeneration() !== accessGeneration ||
        currentUserRef.current !== userId ||
        !projectIdsRef.current.includes(event.project_id) ||
        !chat.is_participant ||
        visible
      )
        return;
      const name = realtimeChatTitle(chat, userId);
      const actor = event.actor
        ? chat.participants.find(
            (participant) =>
              participant.type === event.actor?.type &&
              participant.id === event.actor.id
          )
        : undefined;
      const mentioned = Boolean(
        isMessage &&
        event.mentions?.some(
          (participant) =>
            participant.type === "human" && participant.id === userId
        )
      );
      // Notices for another branch say which one (spec §11.4).
      const where = otherBranch ? ` in ${otherBranch}` : "";
      const title = isHandoff
        ? `Handoff from ${actor?.name ?? "an agent"}${where}`
        : isAdded
          ? `Added to ${name}${where}`
          : isCreated
            ? `New chat from ${actor?.name ?? "an agent"}${where}`
            : mentioned
              ? `Mentioned in ${name}${where}`
              : `New message in ${name}${where}`;
      const body = isHandoff
        ? `${actor?.name ?? "An agent"} handed work to you.`
        : isAdded
          ? "You can open the chat to see the full conversation."
          : isCreated
            ? "A new conversation is ready."
            : mentioned
              ? `${actor?.name ?? "A participant"} mentioned you.`
              : `${actor?.name ?? "A participant"} sent a message.`;
      const notice: ChatNotice = {
        id: `${event.project_id}:${event.sequence}`,
        projectId: event.project_id,
        chatId: chat.id,
        ...(chatBranchId ? { branchId: chatBranchId } : {}),
        ...(event.message_id ? { messageId: event.message_id } : {}),
        title,
        body,
        mentioned
      };
      addNotice(notice, isHandoff && Boolean(event.message_id));
      try {
        if (
          !mountedRef.current ||
          !isControllerCurrent() ||
          currentUserRef.current !== userId
        )
          return;
        if (
          platform.kind === "desktop" &&
          platform.notify &&
          (await platform.isBackgrounded?.())
        ) {
          if (
            !mountedRef.current ||
            !isControllerCurrent() ||
            currentUserRef.current !== userId ||
            !projectIdsRef.current.includes(event.project_id) ||
            getAccessGeneration() !== accessGeneration
          )
            return;
          await platform.notify({
            title: mentioned ? "You were mentioned" : title,
            body,
            destination: {
              kind: "chat",
              projectId: event.project_id,
              chatId: chat.id,
              ...(chatBranchId ? { branchId: chatBranchId } : {})
            }
          });
        }
      } catch {
        // A notification permission or native service failure never interrupts chat delivery.
      }
    },
    [addNotice, api, platform, queryClient]
  );
  const summarizeReconnect = useCallback(
    (
      projectId: string,
      missedMessages: ReplayedChatMessage[],
      isControllerCurrent: () => boolean
    ) => {
      const userId = currentUserRef.current;
      const relevantMessages = missedMessages.filter(
        ({ actorUserId }) => actorUserId !== userId
      );
      if (
        !mountedRef.current ||
        !isControllerCurrent() ||
        !userId ||
        relevantMessages.length < 1 ||
        !projectIdsRef.current.includes(projectId)
      )
        return;
      const replayedChatIds = new Set(
        relevantMessages.map(({ chatId }) => chatId)
      );
      const accessGenerations = new Map(
        [...replayedChatIds].map((chatId) => [
          chatId,
          chatAccessGenerationRef.current.get(`${projectId}:${chatId}`) ?? 0
        ])
      );
      const stillHasAccess = (chatId: string) =>
        (chatAccessGenerationRef.current.get(`${projectId}:${chatId}`) ?? 0) ===
        accessGenerations.get(chatId);
      void api
        .getProjectInbox(projectId, { allBranches: true })
        .then(async (inbox) => {
          if (
            !mountedRef.current ||
            !isControllerCurrent() ||
            currentUserRef.current !== userId ||
            !projectIdsRef.current.includes(projectId)
          )
            return;
          const unread = inbox.unread_chats.filter(
            ({ chat_id }) =>
              replayedChatIds.has(chat_id) && stillHasAccess(chat_id)
          );
          if (!unread.length) return;
          const viewed = viewedBranchId(queryClient, projectId);
          await Promise.all(
            unread.map(async (item) => ({
              item,
              visible: await currentChatIsVisible(
                item.chat_id,
                platform,
                !item.branch_id || !viewed || item.branch_id === viewed
              )
            }))
          ).then(async (visibility) => {
            if (
              !mountedRef.current ||
              !isControllerCurrent() ||
              currentUserRef.current !== userId ||
              !projectIdsRef.current.includes(projectId)
            )
              return;
            const notVisible = visibility
              .filter(
                ({ item, visible }) => !visible && stillHasAccess(item.chat_id)
              )
              .map(({ item }) => item);
            const first = notVisible[0];
            if (!first) return;
            const total = notVisible.reduce(
              (sum, chat) => sum + chat.unread_count,
              0
            );
            const notice = {
              id: `${projectId}:reconnect:${Math.max(...relevantMessages.map(({ eventId }) => eventId))}`,
              projectId,
              chatId: first.chat_id,
              ...(first.branch_id ? { branchId: first.branch_id } : {}),
              title: "Messages arrived while you were away",
              body: `${total || relevantMessages.length} unread message${(total || relevantMessages.length) === 1 ? "" : "s"} across ${notVisible.length} chat${notVisible.length === 1 ? "" : "s"}.`,
              mentioned: notVisible.some((chat) => chat.mention_count > 0)
            };
            addNotice(notice);
            try {
              if (
                platform.kind === "desktop" &&
                platform.notify &&
                (await platform.isBackgrounded?.()) &&
                mountedRef.current &&
                isControllerCurrent() &&
                currentUserRef.current === userId &&
                projectIdsRef.current.includes(projectId) &&
                notVisible.every(({ chat_id }) => stillHasAccess(chat_id))
              ) {
                await platform.notify({
                  title: notice.mentioned ? "Unread mentions" : notice.title,
                  body: notice.body,
                  destination: {
                    kind: "chat",
                    projectId,
                    chatId: first.chat_id,
                    ...(first.branch_id ? { branchId: first.branch_id } : {})
                  }
                });
              }
            } catch {
              // Native reconnect summaries are best effort.
            }
          });
        })
        .catch(() => undefined);
    },
    [addNotice, api, platform, queryClient]
  );
  const projectIdsKey = [...new Set(projectIds)].sort().join("\0");
  const controllers = useMemo(
    () =>
      projectIdsKey
        .split("\0")
        .filter(Boolean)
        .map(
          (projectId) =>
            new ProjectRealtimeController(
              api,
              queryClient,
              projectId,
              undefined,
              Math.random,
              platform,
              undefined,
              (event, isCurrent) => notifyChatEvent(event, isCurrent),
              (missedMessages, isCurrent) =>
                summarizeReconnect(projectId, missedMessages, isCurrent),
              () => currentUserRef.current
            )
        ),
    [
      api,
      notifyChatEvent,
      platform,
      projectIdsKey,
      queryClient,
      summarizeReconnect
    ]
  );
  const orderedProjectIds = projectIdsKey.split("\0").filter(Boolean);
  const previousProjectIdsRef = useRef<string[]>([]);
  useEffect(() => {
    mountedRef.current = true;
    const nextIds = new Set(orderedProjectIds);
    for (const previousId of previousProjectIdsRef.current) {
      if (nextIds.has(previousId)) continue;
      evictProjectMessagingCaches(queryClient, previousId);
      queryClient.removeQueries({
        queryKey: coordinationKeys.all,
        predicate: ({ queryKey }) => queryKey.includes(previousId)
      });
      queryClient.removeQueries({
        queryKey: attentionKeys.project(previousId)
      });
      setNotices((current) =>
        current.filter((notice) => notice.projectId !== previousId)
      );
    }
    previousProjectIdsRef.current = orderedProjectIds;
    const stops = controllers.map((controller) => controller.start());
    return () => {
      mountedRef.current = false;
      stops.forEach((stop) => stop());
    };
  }, [controllers, projectIdsKey, queryClient]);
  const controller =
    controllers[orderedProjectIds.indexOf(activeProjectId)] ?? controllers[0];
  const status = useSyncExternalStore(
    controller?.subscribe ?? (() => () => undefined),
    controller?.getStatus ?? (() => "disconnected" as RealtimeStatus),
    controller?.getStatus ?? (() => "disconnected" as RealtimeStatus)
  );
  return (
    <>
      <RealtimeContext.Provider value={status}>
        {children}
      </RealtimeContext.Provider>
      {notices.length ? (
        <div
          className="fixed right-4 top-4 z-[100] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
          aria-live="polite"
          aria-label="New message notifications"
        >
          {notices.slice(-3).map((notice) => (
            <div
              key={notice.id}
              className="rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
              role="status"
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {notice.mentioned ? "Mentioned you" : notice.title}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {notice.body}
                  </p>
                  <button
                    type="button"
                    className="mt-2 text-xs font-medium underline"
                    onClick={() =>
                      void navigateToChat(
                        notice.projectId,
                        notice.chatId,
                        notice.branchId
                      )
                    }
                  >
                    Open chat
                  </button>
                </div>
                <button
                  type="button"
                  aria-label="Dismiss notification"
                  className="rounded p-1 text-muted-foreground hover:bg-muted"
                  onClick={() => dismissNotice(notice.id)}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
