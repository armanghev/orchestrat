import { randomBytes } from "node:crypto";
import type { projectEvents, Database } from "@orchestrat/db";
import type { RealtimeEventEnvelope } from "@orchestrat/protocol";
import type { WebSocket } from "ws";

type Clock = () => number;
type Random = (size: number) => Buffer;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ProjectEvent = typeof projectEvents.$inferSelect;
export type RealtimeAudience = {
  targetUserIds?: string[];
  excludeUserIds?: string[];
};
type RealtimeNotice = {
  envelope: RealtimeEventEnvelope;
  audience: RealtimeAudience;
};

const entityTypes = new Set([
  "task",
  "claim",
  "agent",
  "credential",
  "session",
  "document",
  "hook",
  "run",
  "chat",
  "branch",
  "merge",
  "decision",
  "repository"
]);
const pendingEvents = new WeakMap<object, ProjectEvent[]>();
const pendingNotices = new WeakMap<object, RealtimeNotice[]>();

export function recordProjectEvent(tx: Transaction, event: ProjectEvent) {
  const events = pendingEvents.get(tx) ?? [];
  events.push(event);
  pendingEvents.set(tx, events);
}

export function recordRealtimeNotice(
  tx: Transaction,
  envelope: RealtimeEventEnvelope,
  audience: RealtimeAudience
) {
  const notices = pendingNotices.get(tx) ?? [];
  notices.push({ envelope, audience });
  pendingNotices.set(tx, notices);
}

const eventEnvelope = (event: ProjectEvent): RealtimeEventEnvelope | null => {
  const [entityType] = event.type.split(".");
  if (!entityTypes.has(entityType)) return null;
  const actor = event.actorUserId
    ? { type: "human" as const, id: event.actorUserId }
    : event.actorAgentId
      ? { type: "agent" as const, id: event.actorAgentId }
      : null;
  const messageId =
    typeof event.payload.message_id === "string"
      ? event.payload.message_id
      : undefined;
  const mentions = Array.isArray(event.payload.mentions)
    ? (event.payload.mentions as {
        type: "human" | "agent";
        id: string;
      }[])
    : undefined;
  const affectedParticipant =
    event.payload.participant && typeof event.payload.participant === "object"
      ? (event.payload.participant as {
          type: "human" | "agent";
          id: string;
        })
      : undefined;
  return {
    project_id: event.projectId,
    // Absent = a project-wide event; dashboards scope invalidation by it.
    ...(event.branchId ? { branch_id: event.branchId } : {}),
    sequence: event.id,
    event_type: event.type,
    entity_type: entityType as RealtimeEventEnvelope["entity_type"],
    entity_id: event.entityId,
    actor,
    ...(messageId ? { message_id: messageId } : {}),
    ...(mentions ? { mentions } : {}),
    ...(affectedParticipant
      ? { affected_participant: affectedParticipant }
      : {})
  };
};

export function withRealtimePublisher(
  db: Database,
  publish: (
    envelope: RealtimeEventEnvelope,
    audience?: RealtimeAudience
  ) => void | Promise<void>
): Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "transaction")
        return Reflect.get(target, property, receiver);
      return async (callback: (tx: Transaction) => Promise<unknown>) => {
        let events: ProjectEvent[] = [];
        let notices: RealtimeNotice[] = [];
        const result = await target.transaction(async (tx) => {
          events = [];
          notices = [];
          pendingEvents.set(tx, events);
          pendingNotices.set(tx, notices);
          return await callback(tx);
        });
        const deliveries = [
          ...events.flatMap((event) => {
            const envelope = eventEnvelope(event);
            return envelope ? [{ envelope, audience: undefined }] : [];
          }),
          ...notices
        ].sort((a, b) => a.envelope.sequence - b.envelope.sequence);
        for (const delivery of deliveries) {
          try {
            void Promise.resolve(
              publish(delivery.envelope, delivery.audience)
            ).catch(() => {
              // Authorization and delivery must not delay or reject a committed mutation.
            });
          } catch {
            // Realtime is best effort and must never fail a committed mutation.
          }
        }
        return result;
      };
    }
  });
}

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

export type AttachmentDownloadTicket = {
  attachmentId: string;
  projectId: string;
  documentId: string;
  expiresAt: number;
};

export class AttachmentDownloadTicketStore {
  // ponytail: in-memory tickets only support one replica; use Redis/shared state for scale-out.
  private readonly tickets = new Map<string, AttachmentDownloadTicket>();

  constructor(
    private readonly clock: Clock = Date.now,
    private readonly random: Random = randomBytes
  ) {}

  issue(
    attachmentId: string,
    projectId: string,
    documentId: string,
    ttlMs = 60_000
  ) {
    const now = this.clock();
    for (const [ticket, record] of this.tickets) {
      if (record.expiresAt <= now) this.tickets.delete(ticket);
    }
    const ticket = this.random(32).toString("base64url");
    const expiresAt = now + ttlMs;
    this.tickets.set(ticket, {
      attachmentId,
      projectId,
      documentId,
      expiresAt
    });
    return { ticket, expiresAt };
  }

  consume(
    ticket: string,
    expected?: Partial<
      Pick<
        AttachmentDownloadTicket,
        "attachmentId" | "projectId" | "documentId"
      >
    >
  ) {
    const record = this.tickets.get(ticket);
    if (!record) return null;
    this.tickets.delete(ticket);
    if (
      record.expiresAt <= this.clock() ||
      (expected?.attachmentId &&
        record.attachmentId !== expected.attachmentId) ||
      (expected?.projectId && record.projectId !== expected.projectId) ||
      (expected?.documentId && record.documentId !== expected.documentId)
    )
      return null;
    return record;
  }
}

export class RealtimeRegistry {
  // ponytail: in-memory connections only support one replica; use Redis/shared state for scale-out.
  private readonly connections = new Map<
    string,
    Map<WebSocket, { userId: string; pending: Promise<void> }>
  >();
  private readonly timers = new WeakMap<WebSocket, NodeJS.Timeout>();

  constructor(
    readonly authorize: (userId: string, projectId: string) => Promise<unknown>,
    private readonly heartbeatMs = 30_000,
    private readonly authorizeEvent?: (
      userId: string,
      envelope: RealtimeEventEnvelope
    ) => Promise<boolean>
  ) {}

  add(projectId: string, userId: string, socket: WebSocket) {
    let sockets = this.connections.get(projectId);
    if (!sockets) this.connections.set(projectId, (sockets = new Map()));
    sockets.set(socket, { userId, pending: Promise.resolve() });
    let alive = true;
    const interval = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return this.remove(projectId, socket);
      }
      alive = false;
      void this.checkAccess(projectId, userId, socket).then((allowed) => {
        if (allowed) {
          try {
            socket.ping();
          } catch {
            this.close(projectId, socket);
          }
        }
      });
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

  private close(projectId: string, socket: WebSocket) {
    this.remove(projectId, socket);
    socket.terminate();
  }

  private async checkAccess(
    projectId: string,
    userId: string,
    socket: WebSocket
  ) {
    if (!this.connections.get(projectId)?.has(socket)) return false;
    try {
      await this.authorize(userId, projectId);
      return (
        this.connections.get(projectId)?.has(socket) &&
        socket.readyState === socket.OPEN
      );
    } catch {
      this.close(projectId, socket);
      return false;
    }
  }

  async publish(
    envelope: RealtimeEventEnvelope,
    audience: RealtimeAudience = {}
  ) {
    await Promise.all(
      [...(this.connections.get(envelope.project_id) ?? [])].map(
        ([socket, connection]) => {
          // Serialize each socket's checks so asynchronous authorization cannot reorder events.
          connection.pending = connection.pending.then(async () => {
            if (
              (await this.checkAccess(
                envelope.project_id,
                connection.userId,
                socket
              )) &&
              (!audience.targetUserIds ||
                audience.targetUserIds.includes(connection.userId)) &&
              !audience.excludeUserIds?.includes(connection.userId) &&
              (!this.authorizeEvent ||
                (await this.authorizeEvent(connection.userId, envelope)))
            ) {
              try {
                socket.send(JSON.stringify(envelope));
              } catch {
                this.close(envelope.project_id, socket);
              }
            }
          });
          return connection.pending;
        }
      )
    );
  }

  size(projectId: string) {
    return this.connections.get(projectId)?.size ?? 0;
  }
}
