import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION
} from "@modelcontextprotocol/server";
import { AgentApiError } from "@orchestrat/sdk";
import { McpBridge } from "./index.js";

const sessionId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const taskId = "00000000-0000-4000-8000-000000000003";
const quiet = {
  cursor: "1",
  branch_id: null,
  unread_chats: [],
  tasks: [],
  handoffs: [],
  blockers_resolved: [],
  truncated: false
};
const handoff = {
  id: "00000000-0000-4000-8000-000000000010",
  chat_id: "00000000-0000-4000-8000-000000000011",
  message_id: "00000000-0000-4000-8000-000000000012",
  message_sequence: 3,
  from: { type: "agent", id: sessionId, name: "codex" },
  to: { type: "agent", id: agentId, name: "claude-code" },
  task: { id: taskId, key: "ORC-7", title: "Parser" },
  chain_id: "00000000-0000-4000-8000-000000000010",
  hop: 0,
  created_at: "2026-09-27T12:00:00.000Z"
};

const connect = async (attention: Record<string, unknown>) => {
  const client = {
    async openSession() {
      return { session: { id: sessionId } };
    },
    async heartbeat() {
      return {};
    },
    async closeSession() {
      return {};
    },
    attention: {
      async summary() {
        return quiet;
      },
      ...attention
    }
  };
  const bridge = new McpBridge({
    client: client as never,
    integration: "codex"
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await bridge.start();
  await bridge.server.connect(serverTransport);
  await clientTransport.start();
  const pending = new Map<number, (response: Record<string, any>) => void>();
  clientTransport.onmessage = (response) => {
    if ("id" in response) pending.get(Number(response.id))?.(response as never);
  };
  let nextId = 1;
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, any>>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      void clientTransport.send({
        jsonrpc: "2.0",
        id,
        method,
        params
      } as never);
    });
  await rpc("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "test", version: "1" }
  });
  await clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  } as never);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await rpc("tools/call", { name, arguments: args })).result;
  return { rpc, call, close: () => clientTransport.close() };
};

test("handoff maps message to body_markdown and passes the idempotency key", async () => {
  const calls: unknown[][] = [];
  const { rpc, call, close } = await connect({
    async handoff(...args: unknown[]) {
      calls.push(args);
      return { handoff };
    }
  });
  const { tools } = (await rpc("tools/list")).result;
  const tool = tools.find(
    (value: { name: string }) => value.name === "handoff"
  );
  assert.ok(tool, "handoff is registered");
  assert.match(tool.description, /ask a human/);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [
    "idempotency_key",
    "message",
    "task_id",
    "to"
  ]);

  const result = await call("handoff", {
    to: { type: "agent", id: agentId },
    message: "  Parser is yours.  ",
    task_id: taskId,
    idempotency_key: "handoff-1"
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { handoff });
  assert.deepEqual(calls, [
    [
      {
        to: { type: "agent", id: agentId },
        body_markdown: "Parser is yours.",
        task_id: taskId
      },
      "handoff-1"
    ]
  ]);

  // Without a task the field is omitted entirely.
  await call("handoff", {
    to: { type: "human", id: agentId },
    message: "FYI",
    idempotency_key: "handoff-2"
  });
  assert.deepEqual(calls[1], [
    { to: { type: "human", id: agentId }, body_markdown: "FYI" },
    "handoff-2"
  ]);
  await close();
});

test("handoff validates input and surfaces limit errors", async () => {
  let called = false;
  const { call, close } = await connect({
    async handoff() {
      called = true;
      throw new AgentApiError(
        429,
        "HANDOFF_CHAIN_LIMIT",
        "This handoff chain reached its limit of 4 hops. Ask a human how to proceed instead of handing off again.",
        { hop: 5, max_hop: 4 },
        "req_1"
      );
    }
  });
  const empty = await call("handoff", {
    to: { type: "agent", id: agentId },
    message: "",
    idempotency_key: "k"
  });
  assert.equal(empty.isError, true);
  const noKey = await call("handoff", {
    to: { type: "agent", id: agentId },
    message: "hi"
  });
  assert.equal(noKey.isError, true);
  assert.equal(called, false);

  const limited = await call("handoff", {
    to: { type: "agent", id: agentId },
    message: "again",
    idempotency_key: "k2"
  });
  assert.equal(called, true);
  assert.equal(limited.isError, true);
  assert.match(limited.content[0].text, /HANDOFF_CHAIN_LIMIT/);
  assert.match(limited.content[0].text, /Ask a human/);
  await close();
});
