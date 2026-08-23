import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode
} from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  realtimeEventEnvelopeSchema,
  type RealtimeEventEnvelope,
  type Task
} from "@orchestrat/protocol";
import type { ApiClient } from "@/lib/api/client";
import {
  invalidateCoordinationQueries,
  invalidateRealtimeEvent
} from "@/features/coordination/query-options";
import type { Platform } from "@/platform/contract";

export type RealtimeStatus = "connecting" | "connected" | "disconnected";
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

export function notificationForRealtimeEvent(
  event: RealtimeEventEnvelope,
  task?: Pick<Task, "status" | "title">
) {
  if (event.event_type === "run.failed")
    return { title: "Agent run failed", body: "An agent run failed." };
  if (event.event_type === "claim.completed")
    return { title: "Task completed", body: "An agent completed a task." };
  if (event.event_type === "claim.expired")
    return { title: "Claim expired", body: "An agent claim expired." };
  if (event.entity_type === "task" && task?.status === "done")
    return { title: "Task completed", body: task.title };
  if (event.entity_type === "task" && task?.status === "blocked")
    return { title: "Agent blocked", body: task.title };
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
  private status: RealtimeStatus = "disconnected";
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: Pick<
      ApiClient,
      | "createRealtimeTicket"
      | "realtimeSocketUrl"
      | "listProjectEvents"
      | "getTask"
    >,
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
      )
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
    } catch {
      this.setStatus("disconnected");
      this.scheduleReconnect();
    }
  }

  private async catchUp(socket: SocketLike) {
    if (this.socket !== socket || this.catchUpSocket !== socket) return;
    let succeeded = false;
    try {
      let after = this.lastSequence ? String(this.lastSequence) : undefined;
      let nextSequence = this.lastSequence;
      let events;
      do {
        events = await this.api.listProjectEvents(this.projectId, { after });
        for (const event of events.events)
          nextSequence = Math.max(nextSequence, event.id);
        after = events.next_cursor ?? undefined;
      } while (events.next_cursor !== null);
      if (this.socket !== socket || this.catchUpSocket !== socket) return;
      this.lastSequence = nextSequence;
      await invalidateCoordinationQueries(this.queryClient, this.projectId);
      succeeded = true;
    } catch {
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
    void this.notifyForEvent(event);
  }

  private async notifyForEvent(event: RealtimeEventEnvelope) {
    try {
      if (
        this.platform?.kind !== "desktop" ||
        !this.platform.notify ||
        event.sequence <= this.lastNotifiedSequence
      )
        return;
      if (!(await this.isBackgrounded())) return;
      let task: Pick<Task, "status" | "title"> | undefined;
      if (
        event.entity_type === "task" &&
        event.entity_id &&
        event.event_type === "task.moved"
      )
        task = await this.api.getTask(event.entity_id);
      const notification = notificationForRealtimeEvent(event, task);
      if (!notification) return;
      this.lastNotifiedSequence = event.sequence;
      await this.platform.notify(notification);
    } catch {
      // Notifications are best effort and must never affect realtime processing.
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

export function ProjectRealtimeProvider({
  api,
  queryClient,
  projectId,
  platform,
  children
}: {
  api: ApiClient;
  queryClient: QueryClient;
  projectId: string;
  platform: Platform;
  children: ReactNode;
}) {
  const controller = useMemo(
    () =>
      new ProjectRealtimeController(
        api,
        queryClient,
        projectId,
        undefined,
        Math.random,
        platform
      ),
    [api, platform, projectId, queryClient]
  );
  useEffect(() => controller.start(), [controller]);
  const status = useSyncExternalStore(
    controller.subscribe,
    controller.getStatus,
    controller.getStatus
  );
  return (
    <RealtimeContext.Provider value={status}>
      {children}
    </RealtimeContext.Provider>
  );
}
