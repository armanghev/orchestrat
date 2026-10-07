import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION
} from "@modelcontextprotocol/server";
import { AgentApiError } from "@orchestrat/sdk";
import { McpBridge, mapMcpError } from "./index.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const harness = async (client: Record<string, unknown>) => {
  const bridge = new McpBridge({
    client: {
      async openSession() {
        return { session: { id: uuid(1) } };
      },
      async heartbeat() {
        return {};
      },
      async closeSession() {
        return {};
      },
      async listChats() {
        return { chats: [] };
      },
      ...client
    } as never,
    integration: "codex"
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await bridge.start();
  await bridge.server.connect(serverTransport);
  await clientTransport.start();
  const pending = new Map<number, (response: Record<string, any>) => void>();
  clientTransport.onmessage = (message) => {
    if ("id" in message) pending.get(Number(message.id))?.(message as never);
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
  const call = async (name: string, args: Record<string, unknown>) =>
    (await rpc("tools/call", { name, arguments: args })).result as {
      isError?: boolean;
      content: { text: string }[];
    };
  return { rpc, call, close: () => clientTransport.close() };
};

test("update_task forwards status and acknowledged_through and describes the rules", async () => {
  const updates: unknown[] = [];
  const { rpc, call, close } = await harness({
    async updateTask(taskId: string, input: unknown) {
      updates.push([taskId, input]);
      return { id: taskId, status: "ready", version: 2 };
    }
  });
  const { tools } = (await rpc("tools/list")).result as {
    tools: {
      name: string;
      description: string;
      inputSchema: { properties: Record<string, unknown> };
    }[];
  };
  const update = tools.find((tool) => tool.name === "update_task")!;
  assert.ok(update.inputSchema.properties.status);
  assert.ok(update.inputSchema.properties.acknowledged_through);
  assert.match(update.description, /set_task_status/);
  assert.match(update.description, /TASK_COMMENTS_UNREAD/);
  for (const name of ["create_tasks", "update_tasks"])
    assert.ok(tools.some((tool) => tool.name === name));

  const moved = await call("update_task", {
    task_id: uuid(2),
    status: "ready",
    expected_version: 1
  });
  assert.equal(moved.isError, undefined);
  const refused = await call("update_task", {
    task_id: uuid(2),
    status: "claimed",
    expected_version: 1
  });
  assert.equal(refused.isError, true);
  await call("update_task", {
    task_id: uuid(2),
    status: "done",
    acknowledged_through: 4,
    expected_version: 2
  });
  assert.deepEqual(updates, [
    [uuid(2), { status: "ready", expected_version: 1 }],
    [uuid(2), { status: "done", acknowledged_through: 4, expected_version: 2 }]
  ]);
  await close();
});

test("create_tasks and update_tasks pass batches through and surface the failing index", async () => {
  const calls: unknown[] = [];
  const { call, close } = await harness({
    async createTasks(input: unknown, key: string) {
      calls.push({ createTasks: input, key });
      return { tasks: [{ key: "ORC-1" }, { key: "ORC-2" }] };
    },
    async updateTasks(input: unknown) {
      calls.push({ updateTasks: input });
      throw new AgentApiError(
        409,
        "TASK_VERSION_CONFLICT",
        "tasks[1]: Task version is stale.",
        { current_version: 3, index: 1, task_id: uuid(3) },
        "req_bulk"
      );
    }
  });
  const created = await call("create_tasks", {
    tasks: [{ title: "One" }, { title: "Two", status: "ready" }],
    idempotency_key: "batch-1"
  });
  assert.equal(created.isError, undefined);
  assert.deepEqual(JSON.parse(created.content[0]!.text).tasks, [
    { key: "ORC-1" },
    { key: "ORC-2" }
  ]);

  const stale = await call("update_tasks", {
    tasks: [
      { task_id: uuid(2), priority: "high", expected_version: 1 },
      { task_id: uuid(3), status: "done", expected_version: 2 }
    ]
  });
  assert.equal(stale.isError, true);
  assert.deepEqual(JSON.parse(stale.content[0]!.text), {
    error: {
      code: "TASK_VERSION_CONFLICT",
      message: "tasks[1]: Task version is stale.",
      details: { current_version: 3, index: 1, task_id: uuid(3) },
      request_id: "req_bulk"
    }
  });

  // Duplicates and per-item rules fail locally with the item's index.
  const duplicate = await call("update_tasks", {
    tasks: [
      { task_id: uuid(2), priority: "high", expected_version: 1 },
      { task_id: uuid(2), status: "done", expected_version: 1 }
    ]
  });
  assert.equal(duplicate.isError, true);
  const duplicateError = JSON.parse(duplicate.content[0]!.text).error;
  assert.equal(duplicateError.code, "VALIDATION_ERROR");
  assert.deepEqual(duplicateError.details, { index: 1, task_id: uuid(2) });
  const empty = await call("update_tasks", {
    tasks: [{ task_id: uuid(2), expected_version: 1 }]
  });
  // Item rules are part of the tool's input schema, so the MCP SDK refuses it.
  assert.equal(empty.isError, true);
  assert.match(empty.content[0]!.text, /At least one task field or status/);

  assert.deepEqual(calls, [
    {
      createTasks: {
        tasks: [{ title: "One" }, { title: "Two", status: "ready" }]
      },
      key: "batch-1"
    },
    {
      updateTasks: {
        tasks: [
          { task_id: uuid(2), priority: "high", expected_version: 1 },
          { task_id: uuid(3), status: "done", expected_version: 2 }
        ]
      }
    }
  ]);
  await close();
});

test("keeps bulk item details next to typed error details", () => {
  const result = mapMcpError(
    new AgentApiError(409, "TASK_NOT_CLAIMABLE", "Claimed.", {
      reason: "claimed",
      index: 2,
      task_id: uuid(4)
    })
  );
  assert.deepEqual(JSON.parse(result.content[0]!.text), {
    error: {
      code: "TASK_NOT_CLAIMABLE",
      message: "Claimed.",
      details: { reason: "claimed", index: 2, task_id: uuid(4) }
    }
  });
});
