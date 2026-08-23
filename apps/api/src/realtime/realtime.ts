import { randomBytes } from "node:crypto";
import type { RealtimeEventEnvelope } from "@orchestrat/protocol";
import type { WebSocket } from "ws";

type Clock = () => number;
type Random = (size: number) => Buffer;

export type RealtimeTicket = {
  projectId: string;
  userId: string;
  expiresAt: number;
};

export class RealtimeTicketStore {
  // ponytail: in-memory tickets only support one replica; use Redis/shared state for scale-out.
  private readonly tickets = new Map<string, RealtimeTicket>();

  constructor(
    private readonly clock: Clock = Date.now,
    private readonly random: Random = randomBytes
  ) {}

  issue(projectId: string, userId: string, ttlMs = 45_000) {
    const now = this.clock();
    for (const [ticket, record] of this.tickets) {
      if (record.expiresAt <= now) this.tickets.delete(ticket);
    }
    const ticket = this.random(32).toString("base64url");
    const expiresAt = now + ttlMs;
    this.tickets.set(ticket, { projectId, userId, expiresAt });
    return { ticket, expiresAt };
  }

  consume(ticket: string, projectId: string, userId?: string) {
    const record = this.tickets.get(ticket);
    if (!record) return null;
    this.tickets.delete(ticket);
    if (record.expiresAt <= this.clock()) return null;
    if (record.projectId !== projectId || (userId && record.userId !== userId))
      return null;
    return record;
  }
}

export class RealtimeRegistry {
  // ponytail: in-memory connections only support one replica; use Redis/shared state for scale-out.
  private readonly connections = new Map<string, Set<WebSocket>>();
  private readonly timers = new WeakMap<WebSocket, NodeJS.Timeout>();

  constructor(private readonly heartbeatMs = 30_000) {}

  add(projectId: string, socket: WebSocket) {
    let sockets = this.connections.get(projectId);
    if (!sockets) this.connections.set(projectId, (sockets = new Set()));
    sockets.add(socket);
    let alive = true;
    const interval = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return this.remove(projectId, socket);
      }
      alive = false;
      socket.ping();
    }, this.heartbeatMs);
    interval.unref();
    this.timers.set(socket, interval);
    const cleanup = () => {
      this.remove(projectId, socket);
    };
    socket.once("close", cleanup);
    socket.once("error", () => {
      socket.terminate();
      cleanup();
    });
    socket.on("pong", () => {
      alive = true;
    });
  }

  remove(projectId: string, socket: WebSocket) {
    const timer = this.timers.get(socket);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(socket);
    }
    const sockets = this.connections.get(projectId);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) this.connections.delete(projectId);
  }

  publish(envelope: RealtimeEventEnvelope) {
    for (const socket of this.connections.get(envelope.project_id) ?? []) {
      try {
        if (socket.readyState === socket.OPEN)
          socket.send(JSON.stringify(envelope));
      } catch {
        socket.terminate();
        this.remove(envelope.project_id, socket);
      }
    }
  }

  size(projectId: string) {
    return this.connections.get(projectId)?.size ?? 0;
  }
}
