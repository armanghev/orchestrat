import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import test from "node:test";
import type { RealtimeEventEnvelope } from "@orchestrat/protocol";
import type { Database } from "@orchestrat/db";
import { buildApp } from "../app.js";
import {
  RealtimeRegistry,
  RealtimeTicketStore,
  recordProjectEvent,
  recordRealtimeNotice,
  withRealtimePublisher
} from "../realtime/realtime.js";
import { realtimeSocketRoutes, realtimeTicketRoutes } from "./realtime.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  sent: string[] = [];
  pingCount = 0;
  terminated = false;
  send(value: string) {
    this.sent.push(value);
  }
  ping() {
    this.pingCount += 1;
  }
  terminate() {
    this.terminated = true;
  }
}

test("the integrated app registers the ticket route at the dashboard contract", async (t) => {
  const app = buildApp({
    allowedOrigins: [],
    auth: {
      async authenticate() {
        return null;
      }
    },
    db: {} as Database
  });
  t.after(async () => app.close());
  await app.ready();
  assert.equal(
    app.hasRoute({ method: "POST", url: "/api/v1/realtime/tickets" }),
    true
  );
  assert.equal(app.hasRoute({ method: "POST", url: "/api/v1/tickets" }), false);
});

test("realtime tickets are high entropy, single use, scoped, and expire", () => {
  let now = 1000;
  const store = new RealtimeTicketStore(
    () => now,
    () => Buffer.alloc(32, 7)
  );
  const issued = store.issue("project-a", "user-a");
  assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(store.consume(issued.ticket, "project-b", "user-a"), null);
  assert.equal(store.consume(issued.ticket, "project-a", "user-a"), null);

  const second = store.issue("project-a", "user-a", 10);
  now = 1010;
  assert.equal(store.consume(second.ticket, "project-a", "user-a"), null);
  const third = store.issue("project-a", "user-a");
  assert.equal(store.consume(third.ticket, "project-a", "user-b"), null);
});

test("registry broadcasts and cleans sockets independently", async () => {
  const registry = new RealtimeRegistry(async () => {});
  const first = new FakeSocket();
  const second = new FakeSocket();
  first.send = () => {
    throw new Error("socket failed");
  };
  registry.add("project-a", "user-a", first as never);
  registry.add("project-a", "user-a", second as never);
  await registry.publish({
    project_id: "project-a",
    sequence: 1,
    event_type: "task.created",
    entity_type: "task",
    entity_id: "550e8400-e29b-41d4-a716-446655440000"
  });
  assert.equal(first.terminated, true);
  assert.equal(second.sent.length, 1);
  assert.equal(registry.size("project-a"), 1);
  second.emit("error", new Error("socket failed"));
  assert.equal(second.terminated, true);
  assert.equal(registry.size("project-a"), 0);
});

test("committed project events publish once, rollback publishes zero, and failures are non-fatal", async () => {
  const projectId = "550e8400-e29b-41d4-a716-446655440000";
  const tx = {};
  let shouldRollback = false;
  const db = {
    async transaction(callback: (value: typeof tx) => Promise<unknown>) {
      const result = await callback(tx);
      if (shouldRollback) throw new Error("rollback");
      return result;
    }
  };
  const published: RealtimeEventEnvelope[] = [];
  const wrapped = withRealtimePublisher(db as never, async (event) => {
    published.push(event);
    if (event.sequence === 2) throw new Error("socket failure");
  });
  const event = (id: number) =>
    recordProjectEvent(tx as never, {
      id,
      projectId,
      type: "task.updated",
      actorAgentId: null,
      actorUserId: null,
      entityId: null,
      payload: {},
      occurredAt: new Date()
    });

  await wrapped.transaction(async (value) => {
    event(1);
    assert.equal(value, tx);
  });
  await wrapped.transaction(async () => event(2));
  await wrapped.transaction(async () => {
    recordProjectEvent(tx as never, {
      id: 4,
      projectId,
      type: "run.failed",
      actorAgentId: null,
      actorUserId: null,
      entityId: null,
      payload: {},
      occurredAt: new Date()
    });
  });
  shouldRollback = true;
  await assert.rejects(() => wrapped.transaction(async () => event(3)));
  assert.deepEqual(
    published.map(({ sequence }) => sequence),
    [1, 2, 4]
  );
  assert.equal(published[2]?.event_type, "run.failed");
  assert.equal(published[2]?.entity_type, "run");
});

test("targeted notices and project events publish in persisted sequence order", async () => {
  const projectId = "550e8400-e29b-41d4-a716-446655440000";
  const tx = {};
  const db = {
    async transaction(callback: (value: typeof tx) => Promise<unknown>) {
      return callback(tx);
    }
  };
  const delivered: Array<{
    sequence: number;
    targets: string[] | undefined;
  }> = [];
  const wrapped = withRealtimePublisher(db as never, (event, audience) => {
    delivered.push({
      sequence: event.sequence,
      targets: audience?.targetUserIds
    });
  });

  await wrapped.transaction(async (value) => {
    recordProjectEvent(value, {
      id: 12,
      projectId,
      type: "chat.member_added",
      actorAgentId: null,
      actorUserId: "550e8400-e29b-41d4-a716-446655440001",
      entityId: "550e8400-e29b-41d4-a716-446655440002",
      payload: {},
      occurredAt: new Date()
    });
    recordRealtimeNotice(
      value,
      {
        project_id: projectId,
        sequence: 11,
        event_type: "chat.access_invalidated",
        entity_type: "chat",
        entity_id: "550e8400-e29b-41d4-a716-446655440002"
      },
      { targetUserIds: ["550e8400-e29b-41d4-a716-446655440003"] }
    );
  });

  assert.deepEqual(delivered, [
    {
      sequence: 11,
      targets: ["550e8400-e29b-41d4-a716-446655440003"]
    },
    { sequence: 12, targets: undefined }
  ]);
});

test("targeted realtime delivery reaches only the requested current project member", async (t) => {
  const registry = new RealtimeRegistry(async () => {});
  const formerObserver = new FakeSocket();
  const currentParticipant = new FakeSocket();
  registry.add("project-a", "former-observer", formerObserver as never);
  registry.add("project-a", "current-participant", currentParticipant as never);
  t.after(() => {
    formerObserver.emit("close");
    currentParticipant.emit("close");
  });

  await registry.publish(
    {
      project_id: "project-a",
      sequence: 3,
      event_type: "chat.access_invalidated",
      entity_type: "chat",
      entity_id: "550e8400-e29b-41d4-a716-446655440000"
    },
    { targetUserIds: ["former-observer"] }
  );

  assert.equal(formerObserver.sent.length, 1);
  assert.equal(currentParticipant.sent.length, 0);
});

test("registry pings and terminates sockets that miss the next pong", async () => {
  const registry = new RealtimeRegistry(async () => {}, 10);
  const socket = new FakeSocket();
  registry.add("project-a", "user-a", socket as never);
  await wait(15);
  assert.equal(socket.pingCount, 1);
  socket.emit("pong");
  await wait(12);
  assert.equal(socket.pingCount, 2);
  await wait(12);
  assert.equal(socket.terminated, true);
  assert.equal(registry.size("project-a"), 0);
});

test("ticket and websocket routes enforce project scope and single use", async (t) => {
  const projectA = "550e8400-e29b-41d4-a716-446655440000";
  const projectB = "9a787b7b-84c1-4d76-83a4-0f76997e5981";
  const app = Fastify();
  t.after(async () => app.close());
  app.register(websocket);
  app.decorateRequest("userId", "user-a");
  const tickets = new RealtimeTicketStore(
    () => 1000,
    () => Buffer.alloc(32, 8)
  );
  const registry = new RealtimeRegistry(async () => {});
  await app.register(realtimeTicketRoutes, {
    prefix: "/api/v1/realtime",
    projects: {
      async getProject(userId, projectId) {
        assert.equal(userId, "user-a");
        assert.equal(projectId, projectA);
      }
    },
    tickets
  });
  await app.register(realtimeSocketRoutes, {
    prefix: "/api/v1/realtime",
    registry,
    tickets
  });
  const ticketResponse = await app.inject({
    method: "POST",
    payload: { project_id: projectA },
    url: "/api/v1/realtime/tickets"
  });
  assert.equal(ticketResponse.statusCode, 200, ticketResponse.body);
  const ticket = ticketResponse.json().ticket as string;
  const socket = await app.injectWS(
    `/api/v1/realtime/projects/${projectA}?ticket=${ticket}`
  );
  t.after(() => socket.terminate());
  assert.equal(registry.size(projectA), 1);
  socket.terminate();
  registry.remove(projectA, socket as never);
  await assert.rejects(() =>
    app.injectWS(`/api/v1/realtime/projects/${projectA}?ticket=${ticket}`)
  );
  const wrongProject = tickets.issue(projectA, "user-a").ticket;
  await assert.rejects(() =>
    app.injectWS(`/api/v1/realtime/projects/${projectB}?ticket=${wrongProject}`)
  );
});

test("registry reauthorizes queued events, fails closed, and closes revoked idle sockets", async (t) => {
  const denied = new Set<string>();
  let release: (() => void) | undefined;
  let stalled = false;
  const registry = new RealtimeRegistry(async (userId) => {
    if (stalled && userId === "allowed") {
      stalled = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    if (denied.has(userId))
      throw new Error("membership removed or lookup failed");
  }, 15);
  const allowed = new FakeSocket(),
    revoked = new FakeSocket();
  registry.add("project-a", "allowed", allowed as never);
  registry.add("project-a", "revoked", revoked as never);
  t.after(() => {
    allowed.emit("close");
    revoked.emit("close");
  });
  const envelope = (sequence: number): RealtimeEventEnvelope => ({
    project_id: "project-a",
    sequence,
    event_type: "task.created",
    entity_type: "task",
    entity_id: null
  });
  await registry.publish(envelope(1));
  denied.add("revoked");
  stalled = true;
  const second = registry.publish(envelope(2));
  const third = registry.publish(envelope(3));
  await wait(0);
  release!();
  await Promise.all([second, third]);
  assert.deepEqual(
    allowed.sent.map((value) => JSON.parse(value).sequence),
    [1, 2, 3]
  );
  assert.equal(revoked.sent.length, 1);
  assert.equal(revoked.terminated, true);
  denied.add("allowed");
  await wait(25);
  assert.equal(allowed.terminated, true);
  assert.equal(registry.size("project-a"), 0);
});

test("membership removal and leave reject preissued tickets and established subscriptions", async (t) => {
  const { fixture } = await import("../test/fixture.js");
  const { PermissionService } =
    await import("../services/permission-service.js");
  const { ProjectService } = await import("../services/project-service.js");
  const { organizationMembers, projectMembers, users } =
    await import("@orchestrat/db");
  const { app, db } = await fixture();
  t.after(() => app.close());
  const organization = (
    await app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: { authorization: "Bearer alice" },
      payload: { name: "Realtime" }
    })
  ).json();
  const project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/organizations/${organization.id}/projects`,
      headers: { authorization: "Bearer alice" },
      payload: { name: "Private" }
    })
  ).json();
  const [alice] = await db.select().from(users);
  const bob = "550e8400-e29b-41d4-a716-446655440001";
  await db.insert(users).values({
    id: bob,
    authProvider: "supabase",
    authSubject: bob,
    name: "bob",
    email: "bob@example.com"
  });
  const permissions = new PermissionService(db);
  const projects = new ProjectService(db, async () => undefined);
  const tickets = new RealtimeTicketStore();
  const registry = new RealtimeRegistry((userId, projectId) =>
    permissions.projectAccess(userId, projectId)
  );
  const wsApp = Fastify();
  wsApp.register(websocket);
  wsApp.decorateRequest("userId", "");
  await wsApp.register(realtimeSocketRoutes, { tickets, registry });
  await wsApp.ready();
  t.after(() => wsApp.close());
  for (const leave of [false, true]) {
    await db
      .insert(organizationMembers)
      .values({ organizationId: organization.id, userId: bob, role: "member" });
    await db
      .insert(projectMembers)
      .values({ projectId: project.id, userId: bob, role: "member" });
    const pending = tickets.issue(project.id, bob).ticket;
    const live = await wsApp.injectWS(
      `/projects/${project.id}?ticket=${tickets.issue(project.id, bob).ticket}`
    );
    const messages: string[] = [];
    live.on("message", (data) => messages.push(String(data)));
    const event: RealtimeEventEnvelope = {
      project_id: project.id,
      sequence: 1,
      event_type: "task.created",
      entity_type: "task",
      entity_id: null
    };
    await registry.publish(event);
    await wait(0);
    assert.equal(messages.length, 1);
    if (leave) await projects.leaveOrganization(bob, organization.id);
    else await projects.removeMember(alice!.id, organization.id, bob);
    await registry.publish({ ...event, sequence: 2 });
    assert.equal(registry.size(project.id), 0);
    assert.equal(messages.length, 1);
    await assert.rejects(
      wsApp.injectWS(`/projects/${project.id}?ticket=${pending}`)
    );
    live.terminate();
  }
});

test("stalled socket authorization cannot delay a committed mutation or disclose events", async (t) => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(release);
  const registry = new RealtimeRegistry(() => blocked, 10);
  const socket = new FakeSocket();
  registry.add("project-a", "user-a", socket as never);
  t.after(() => socket.emit("close"));
  const tx = {};
  const db = {
    transaction: async (callback: (tx: object) => Promise<unknown>) => {
      await callback(tx);
      return "committed";
    }
  };
  const wrapped = withRealtimePublisher(db as never, (event) =>
    registry.publish(event)
  );
  const result = wrapped.transaction(async () =>
    recordProjectEvent(tx as never, {
      id: 1,
      projectId: "project-a",
      type: "task.updated",
      actorAgentId: null,
      actorUserId: null,
      entityId: null,
      payload: {},
      occurredAt: new Date()
    })
  );
  assert.equal(
    await Promise.race([result, wait(100).then(() => "blocked")]),
    "committed"
  );
  await wait(30);
  assert.equal(registry.size("project-a"), 0);
  assert.equal(socket.sent.length, 0);
  release();
  await wait(0);
  assert.equal(socket.sent.length, 0);
});
