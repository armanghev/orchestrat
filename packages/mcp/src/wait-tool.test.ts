import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  McpServer
} from "@modelcontextprotocol/server";
import type { AttentionToolHost, ToolResult } from "./attention-tools.js";
import { ClaimTokenStore, McpBridge } from "./index.js";
import { registerWaitTool, waitBudget } from "./wait-tool.js";

const id = "00000000-0000-4000-8000-000000000001";
const summary = {
  cursor: "0",
  branch_id: null,
  unread_chats: [],
  tasks: [],
  handoffs: [],
  blockers_resolved: [],
  truncated: false
};
type Query = { after?: string; timeout_ms: number; directed_only: boolean };
type Wait = (query: Query, signal: AbortSignal) => Promise<unknown>;

const rpcOver = async (server: McpServer) => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await clientTransport.start();
  const pending = new Map<number, (response: Record<string, any>) => void>();
  const notifications: Record<string, any>[] = [];
  clientTransport.onmessage = (message) => {
    if ("id" in message) pending.get(Number(message.id))?.(message as never);
    else notifications.push(message as never);
  };
  let nextId = 1;
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const requestId = nextId++;
    const response = new Promise<Record<string, any>>((resolve) =>
      pending.set(requestId, resolve)
    );
    void clientTransport.send({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params
    } as never);
    return { requestId, response };
  };
  await send("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "test", version: "1" }
  }).response;
  await clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  } as never);
  const call = async (
    args: Record<string, unknown> = {},
    meta?: Record<string, unknown>
  ) =>
    (
      await send("tools/call", {
        name: "wait_for_update",
        arguments: args,
        ...(meta ? { _meta: meta } : {})
      }).response
    ).result as ToolResult;
  return {
    send,
    call,
    notifications,
    cancel: (requestId: number) =>
      clientTransport.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId, reason: "test" }
      } as never),
    close: () => clientTransport.close()
  };
};

// A host around a fake clock: each timed-out round advances the clock by the
// round's timeout, so budgets run instantly.
const connect = async (
  integration: string,
  options: { waitBudgetSeconds?: number; wait?: Wait } = {}
) => {
  let clock = 0;
  let round = 0;
  const queries: Query[] = [];
  const wait: Wait =
    options.wait ??
    (async (query) => {
      clock += query.timeout_ms;
      return {
        status: "timeout",
        events: [],
        cursor: String(++round),
        attention: summary
      };
    });
  const server = new McpServer({ name: "test", version: "1" });
  const host: AttentionToolHost = {
    server,
    async call(operation) {
      try {
        return {
          content: [{ type: "text", text: JSON.stringify(await operation()) }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: String(error) }]
        };
      }
    },
    client: () =>
      ({
        attention: {
          wait: (query: Query, signal: AbortSignal) => {
            queries.push(query);
            return wait(query, signal);
          }
        }
      }) as never,
    requireSession: () => id,
    claims: new ClaimTokenStore(),
    integration,
    waitBudgetSeconds: options.waitBudgetSeconds
  };
  registerWaitTool(host, { now: () => clock });
  return { ...(await rpcOver(server)), queries };
};
const parse = (result: ToolResult) => JSON.parse(result.content[0]!.text);

test("budgets follow the integration table and clamp to its ceiling", () => {
  assert.deepEqual(waitBudget("claude-code"), {
    defaultSeconds: 110,
    maxSeconds: 1800
  });
  assert.deepEqual(waitBudget("codex"), { defaultSeconds: 50, maxSeconds: 50 });
  assert.deepEqual(waitBudget("codex", 300), {
    defaultSeconds: 300,
    maxSeconds: 300
  });
  assert.deepEqual(waitBudget("codex", 660), {
    defaultSeconds: 600,
    maxSeconds: 600
  });
  assert.deepEqual(waitBudget("cursor", 660), {
    defaultSeconds: 50,
    maxSeconds: 50
  });
  assert.deepEqual(waitBudget("antigravity"), {
    defaultSeconds: 150,
    maxSeconds: 150
  });
  assert.deepEqual(waitBudget("antigravity", 660), {
    defaultSeconds: 600,
    maxSeconds: 600
  });
  assert.deepEqual(waitBudget("opencode"), {
    defaultSeconds: 600,
    maxSeconds: 1800
  });
  assert.deepEqual(waitBudget("something-else"), {
    defaultSeconds: 50,
    maxSeconds: 50
  });
});

test("waits in rounds of at most 25 s until the budget is spent", async () => {
  const { call, queries, notifications, close } = await connect("claude-code");
  const result = await call({ directed_only: true });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.deepEqual(parse(result), {
    status: "no_updates",
    waited_seconds: 110,
    cursor: "5",
    next_step:
      "Nothing happened in 110s. Call wait_for_update again with this cursor, or end your turn; Orchestrat hooks (if installed) will surface new work."
  });
  assert.deepEqual(queries, [
    { timeout_ms: 25_000, directed_only: true },
    { after: "1", timeout_ms: 25_000, directed_only: true },
    { after: "2", timeout_ms: 25_000, directed_only: true },
    { after: "3", timeout_ms: 25_000, directed_only: true },
    { after: "4", timeout_ms: 10_000, directed_only: true }
  ]);
  // No progress token, no progress notifications.
  assert.equal(
    notifications.filter(
      (message) => message.method === "notifications/progress"
    ).length,
    0
  );
  await close();
});

test("sends progress between rounds only when the client asked for it", async () => {
  const { call, notifications, close } = await connect("opencode");
  const result = await call(
    { cursor: "7", max_wait_seconds: 60 },
    { progressToken: "wait-1" }
  );
  assert.equal(parse(result).waited_seconds, 60);
  assert.deepEqual(
    notifications
      .filter((message) => message.method === "notifications/progress")
      .map(({ params }) => [
        params.progressToken,
        params.progress,
        params.total,
        params.message
      ]),
    [
      ["wait-1", 25, 60, "Waiting for updates (25s of 60s)"],
      ["wait-1", 50, 60, "Waiting for updates (50s of 60s)"]
    ]
  );
  await close();
});

test("max_wait_seconds is clamped to the integration ceiling", async () => {
  const total = async (
    integration: string,
    args: Record<string, unknown>,
    budget?: number
  ) => {
    const { call, queries, close } = await connect(integration, {
      waitBudgetSeconds: budget
    });
    const result = await call(args);
    await close();
    return {
      waited: parse(result).waited_seconds,
      requested: queries.reduce((sum, query) => sum + query.timeout_ms, 0)
    };
  };
  assert.deepEqual(await total("cursor", { max_wait_seconds: 1800 }), {
    waited: 50,
    requested: 50_000
  });
  assert.deepEqual(await total("codex", { max_wait_seconds: 1800 }), {
    waited: 50,
    requested: 50_000
  });
  assert.deepEqual(await total("codex", { max_wait_seconds: 1800 }, 660), {
    waited: 600,
    requested: 600_000
  });
  assert.deepEqual(await total("claude-code", { max_wait_seconds: 1800 }), {
    waited: 1800,
    requested: 1_800_000
  });
  assert.deepEqual(await total("claude-code", { max_wait_seconds: 30 }), {
    waited: 30,
    requested: 30_000
  });
  // max_wait_seconds: 0 polls once.
  assert.deepEqual(await total("opencode", { max_wait_seconds: 0 }), {
    waited: 0,
    requested: 0
  });
  const { call, queries, close } = await connect("claude-code");
  for (const invalid of [
    { max_wait_seconds: 1801 },
    { max_wait_seconds: -1 },
    { cursor: "abc" }
  ])
    assert.equal((await call(invalid)).isError, true);
  assert.equal(queries.length, 0);
  await close();
});

test("returns updates and pending results at once", async () => {
  const event = {
    kind: "direct_message",
    event_id: 9,
    occurred_at: "2026-09-28T00:00:00.000Z",
    actor: { type: "agent", id, name: "agent-b" },
    task: null,
    chat_id: id,
    message_id: id,
    excerpt: "ping",
    branch_id: null
  };
  for (const status of ["updates", "pending"] as const) {
    const { call, queries, close } = await connect("claude-code", {
      wait: async () => ({
        status,
        events: status === "updates" ? [event] : [],
        cursor: "9",
        attention: summary
      })
    });
    const result = await call({ cursor: "3" });
    assert.deepEqual(parse(result), {
      status,
      events: status === "updates" ? [event] : [],
      cursor: "9",
      attention: summary
    });
    assert.equal(queries.length, 1);
    await close();
  }
});

test("a cancelled call aborts the in-flight round and stops", async () => {
  let aborted: () => void = () => undefined;
  const abortedSignal = new Promise<void>((resolve) => (aborted = resolve));
  const { send, cancel, queries, close } = await connect("claude-code", {
    wait: (_query, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted();
          reject(new Error("aborted"));
        });
      })
  });
  const { requestId } = send("tools/call", {
    name: "wait_for_update",
    arguments: {}
  });
  while (queries.length === 0)
    await new Promise((resolve) => setImmediate(resolve));
  await cancel(requestId);
  await abortedSignal;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(queries.length, 1);
  await close();
});

test("the bridge registers wait_for_update without a duplicate notice", async () => {
  let summaries = 0;
  const waits: unknown[] = [];
  const bridge = new McpBridge({
    client: {
      async openSession() {
        return { session: { id } };
      },
      async heartbeat() {
        return {};
      },
      async closeSession() {
        return {};
      },
      attention: {
        async summary() {
          summaries += 1;
          return summary;
        },
        async wait(query: unknown) {
          waits.push(query);
          return {
            status: "pending",
            events: [],
            cursor: "4",
            attention: summary
          };
        }
      }
    } as never,
    integration: "codex",
    waitBudgetSeconds: 660
  });
  await bridge.start();
  const { send, close } = await rpcOver(bridge.server);
  const listed = (await send("tools/list").response).result.tools;
  const tool = listed.find(
    (value: { name: string }) => value.name === "wait_for_update"
  );
  assert.match(
    tool.description,
    /^Call this instead of ending your turn when you are blocked or waiting on another agent\./
  );
  assert.match(tool.description, /max_wait_seconds may raise that to 600s/);
  const result = (
    await send("tools/call", { name: "wait_for_update", arguments: {} })
      .response
  ).result as ToolResult;
  assert.equal(result.content.length, 1);
  assert.equal(parse(result).status, "pending");
  assert.deepEqual(waits, [{ timeout_ms: 25_000, directed_only: false }]);
  assert.equal(summaries, 0);
  await close();
  await bridge.stop();
});
