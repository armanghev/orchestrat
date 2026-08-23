import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import test from "node:test";
import {
  RealtimeRegistry,
  RealtimeTicketStore,
  recordProjectEvent,
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

test("registry broadcasts and cleans sockets independently", () => {
  const registry = new RealtimeRegistry();
  const first = new FakeSocket();
  const second = new FakeSocket();
  first.send = () => {
    throw new Error("socket failed");
  };
  registry.add("project-a", first as never);
  registry.add("project-a", second as never);
  registry.publish({
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
  const published: number[] = [];
  const wrapped = withRealtimePublisher(db as never, (event) => {
    published.push(event.sequence);
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
  shouldRollback = true;
  await assert.rejects(() => wrapped.transaction(async () => event(3)));
  assert.deepEqual(published, [1, 2]);
});

test("registry pings and terminates sockets that miss the next pong", async () => {
  const registry = new RealtimeRegistry(10);
  const socket = new FakeSocket();
  registry.add("project-a", socket as never);
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
  const registry = new RealtimeRegistry();
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
