import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION
} from "@modelcontextprotocol/server";
import { attentionNotice } from "./attention-tools.js";
import { McpBridge } from "./index.js";

const id = "00000000-0000-4000-8000-000000000001";
const blockId = "00000000-0000-4000-8000-000000000002";
const summary = {
  cursor: "42",
  branch_id: null,
  unread_chats: [{ chat_id: id, unread_count: 1, mention_count: 0 }],
  tasks: [],
  handoffs: [],
  blockers_resolved: [],
  truncated: false
};

const connect = async (attention: Record<string, unknown>) => {
  const client = {
    async openSession() {
      return { session: { id } };
    },
    async heartbeat() {
      return {};
    },
    async closeSession() {
      return {};
    },
    attention
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
      const idNumber = nextId++;
      pending.set(idNumber, resolve);
      void clientTransport.send({
        jsonrpc: "2.0",
        id: idNumber,
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

test("registers the attention tools alongside the existing ones", async () => {
  const { rpc, close } = await connect({});
  const { tools } = (await rpc("tools/list")).result;
  const names = tools.map((tool: { name: string }) => tool.name);
  for (const name of ["get_attention", "acknowledge_attention", "watch_task"])
    assert.ok(names.includes(name), name);
  // 27 bridge tools (no project picker), the three attention tools,
  // wait_for_update, set_task_status and handoff, and the two branch tools.
  assert.equal(names.length, 35);
  const watch = tools.find(
    (tool: { name: string }) => tool.name === "watch_task"
  );
  assert.match(watch.description, /Mentions of this agent still surface/);
  await close();
});

test("get_attention returns the full summary without a duplicate notice", async () => {
  let calls = 0;
  const { call, close } = await connect({
    async summary() {
      calls += 1;
      return summary;
    }
  });
  const result = await call("get_attention");
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.deepEqual(JSON.parse(result.content[0].text), summary);
  assert.equal(calls, 1);
  await close();
});

test("acknowledge_attention passes items through and validates them", async () => {
  const acknowledged: unknown[] = [];
  const { call, close } = await connect({
    async summary() {
      return { ...summary, unread_chats: [] };
    },
    async acknowledge(input: unknown) {
      acknowledged.push(input);
      return { acknowledged: 2 };
    }
  });
  const items = [
    { type: "task_comments", task_id: id, through_sequence: 4 },
    { type: "blocker", block_id: blockId }
  ];
  const result = await call("acknowledge_attention", { items });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { acknowledged: 2 });
  assert.deepEqual(acknowledged, [{ items }]);
  for (const invalid of [
    [],
    [{ type: "chat", chat_id: id }],
    [{ type: "task_comments", task_id: id, through_sequence: -1 }],
    Array.from({ length: 51 }, () => ({ type: "handoff", handoff_id: id }))
  ]) {
    const refused = await call("acknowledge_attention", { items: invalid });
    assert.equal(refused.isError, true);
  }
  assert.equal(acknowledged.length, 1);
  await close();
});

test("watch_task watches or mutes and appends the attention notice", async () => {
  const watched: unknown[] = [];
  const { call, close } = await connect({
    async summary() {
      return {
        ...summary,
        unread_chats: [],
        blockers_resolved: [
          {
            block_id: blockId,
            task: { id, key: "ORC-9", title: "Blocked" },
            resolution: "participant_responded",
            resolved_at: "2026-09-28T00:00:00.000Z"
          }
        ]
      };
    },
    async watch(taskId: string, watching: boolean) {
      watched.push([taskId, watching]);
      return {
        task_id: taskId,
        state: watching ? "watching" : "muted",
        reason: "explicit",
        last_read_sequence: 0
      };
    }
  });
  const muted = await call("watch_task", { task_id: id, watching: false });
  assert.equal(muted.isError, undefined);
  assert.equal(JSON.parse(muted.content[0].text).state, "muted");
  assert.deepEqual(JSON.parse(muted.content[1].text).notice.blockers_resolved, [
    {
      block_id: blockId,
      task_key: "ORC-9",
      resolution: "participant_responded"
    }
  ]);
  const refused = await call("watch_task", {
    task_id: "not-a-uuid",
    watching: true
  });
  assert.equal(refused.isError, true);
  const missing = await call("watch_task", { task_id: id });
  assert.equal(missing.isError, true);
  assert.deepEqual(watched, [[id, false]]);
  await close();
});

test("attentionNotice stays silent when only chats are unread", () => {
  assert.equal(attentionNotice(summary), undefined);
});
