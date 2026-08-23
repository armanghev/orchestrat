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
  type RealtimeEventEnvelope
} from "@orchestrat/protocol";
import type { ApiClient } from "@/lib/api/client";
import {
  invalidateCoordinationQueries,
  invalidateRealtimeEvent
} from "@/features/coordination/query-options";

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

export class ProjectRealtimeController {
  private socket: SocketLike | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSequence = 0;
  private catchUpSocket: SocketLike | null = null;
  private buffered: RealtimeEventEnvelope[] = [];
  private status: RealtimeStatus = "disconnected";
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: Pick<
      ApiClient,
      "createRealtimeTicket" | "realtimeSocketUrl" | "listProjectEvents"
    >,
    private readonly queryClient: QueryClient,
    private readonly projectId: string,
    private readonly socketFactory: SocketFactory = defaultSocket,
    private readonly random = Math.random
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
  children
}: {
  api: ApiClient;
  queryClient: QueryClient;
  projectId: string;
  children: ReactNode;
}) {
  const controller = useMemo(
    () => new ProjectRealtimeController(api, queryClient, projectId),
    [api, projectId, queryClient]
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
