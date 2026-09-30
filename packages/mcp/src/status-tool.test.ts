import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION
} from "@modelcontextprotocol/server";
import { AgentApiError } from "@orchestrat/sdk";
import { McpBridge } from "./index.js";

const sessionId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const claimId = "00000000-0000-4000-8000-000000000003";
const agentId = "00000000-0000-4000-8000-000000000004";
const claimToken = `claim_${"t".repeat(43)}`;
const emptySummary = {
  cursor: "1",
  branch_id: null,
  unread_chats: [],
  tasks: [],
  handoffs: [],
  blockers_resolved: [],
  truncated: false
};
const claim = {
  id: claimId,
  project_id: sessionId,
  task_id: taskId,
  agent_id: agentId,
  session_id: sessionId,
  status: "active",
  claimed_at: "2026-09-28T00:00:00.000Z",
  lease_expires_at: "2026-09-28T00:05:00.000Z",
  released_at: null,
  completed_at: null
};
const response = (status: string, claimStatus = "active") => ({
  task: { id: taskId, key: "ORC-14", status, version: 3 },
  claim: {
    id: claimId,
    status: claimStatus,
    lease_expires_at: claim.lease_expires_at
  },
  block: null
});

const connect = async (
  setStatus: (sessionId: string, input: Record<string, unknown>) => unknown
) => {
  const calls: [string, Record<string, unknown>][] = [];
  const completions: unknown[] = [];
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
    async claimTask() {
      return { claim, claim_token: claimToken };
    },
    async completeClaim(_session: string, input: unknown) {
      completions.push(input);
      return { claim: { ...claim, status: "completed" } };
    },
    attention: {
      async summary() {
        return emptySummary;
      },
      async setStatus(session: string, input: Record<string, unknown>) {
        calls.push([session, input]);
        return setStatus(session, input);
      }
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
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await rpc("tools/call", { name, arguments: args })).result;
  return {
    rpc,
    call,
    calls,
    completions,
    close: () => clientTransport.close()
  };
};
const errorOf = (result: { content: { text: string }[] }) =>
  JSON.parse(result.content[0].text).error;

test("set_task_status is registered with the blocked guidance", async () => {
  const { rpc, close } = await connect(() => response("in_progress"));
  const { tools } = (await rpc("tools/list")).result;
  const tool = tools.find(
    (item: { name: string }) => item.name === "set_task_status"
  );
  assert.ok(tool);
  assert.match(tool.description, /wait_for_update/);
  assert.deepEqual(tool.inputSchema.required, ["task_id", "status"]);
  await close();
});

test("set_task_status needs the local claim token", async () => {
  const { call, calls, close } = await connect(() => response("in_progress"));
  const result = await call("set_task_status", {
    task_id: taskId,
    status: "in_progress"
  });
  assert.equal(result.isError, true);
  assert.equal(errorOf(result).code, "CLAIM_NOT_FOUND");
  assert.equal(calls.length, 0);
  await close();
});

test("set_task_status sends the token and keeps it for in_progress and blocked", async () => {
  const { call, calls, close } = await connect((_session, input) =>
    response(String(input.status))
  );
  assert.equal(
    (await call("claim_task", { task_id: taskId })).isError,
    undefined
  );
  const started = await call("set_task_status", {
    task_id: taskId,
    status: "in_progress"
  });
  assert.equal(started.isError, undefined);
  assert.equal(JSON.parse(started.content[0].text).task.status, "in_progress");
  const blocked = await call("set_task_status", {
    task_id: taskId,
    status: "blocked",
    reason: "waiting on the API",
    blocked_on: { type: "agent", id: agentId },
    blocking_task_id: claimId
  });
  assert.equal(blocked.isError, undefined);
  assert.deepEqual(calls, [
    [sessionId, { claim_token: claimToken, status: "in_progress" }],
    [
      sessionId,
      {
        claim_token: claimToken,
        status: "blocked",
        reason: "waiting on the API",
        blocked_on: { type: "agent", id: agentId },
        blocking_task_id: claimId
      }
    ]
  ]);
  await close();
});

test("set_task_status validates before calling the API", async () => {
  const { call, calls, close } = await connect(() => response("blocked"));
  await call("claim_task", { task_id: taskId });
  for (const args of [
    { status: "blocked" },
    { status: "in_progress", blocked_on: { type: "agent", id: agentId } },
    { status: "review", blocking_task_id: claimId },
    { status: "done" },
    { status: "blocked", reason: "x".repeat(501) }
  ]) {
    const result = await call("set_task_status", { task_id: taskId, ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  const refused = await call("set_task_status", {
    task_id: taskId,
    status: "blocked"
  });
  assert.equal(errorOf(refused).code, "VALIDATION_ERROR");
  assert.equal(calls.length, 0);
  await close();
});

test("review keeps the token on 409 and drops it on success", async () => {
  let unread = true;
  const { call, calls, completions, close } = await connect(() => {
    if (unread)
      throw new AgentApiError(
        409,
        "TASK_COMMENTS_UNREAD",
        "Read the new task comments before ending the claim, then pass acknowledged_through.",
        {
          task_id: taskId,
          latest_sequence: 2,
          total_unread: 1,
          unread: [
            {
              sequence: 2,
              author: { type: "agent", id: agentId, name: "codex" },
              excerpt: "one more thing",
              created_at: "2026-09-28T00:01:00.000Z"
            }
          ]
        }
      );
    return response("review", "released");
  });
  await call("claim_task", { task_id: taskId });
  const refused = await call("set_task_status", {
    task_id: taskId,
    status: "review"
  });
  assert.equal(refused.isError, true);
  const error = errorOf(refused);
  assert.equal(error.code, "TASK_COMMENTS_UNREAD");
  assert.equal(error.details.latest_sequence, 2);
  assert.equal(error.details.unread[0].excerpt, "one more thing");
  unread = false;
  const reviewed = await call("set_task_status", {
    task_id: taskId,
    status: "review",
    acknowledged_through: 2
  });
  assert.equal(reviewed.isError, undefined);
  assert.equal(JSON.parse(reviewed.content[0].text).claim.status, "released");
  assert.deepEqual(calls.at(-1), [
    sessionId,
    { claim_token: claimToken, status: "review", acknowledged_through: 2 }
  ]);
  // The claim ended with review, so the local token is gone.
  for (const [name, args] of [
    ["set_task_status", { task_id: taskId, status: "in_progress" }],
    ["complete_task", { task_id: taskId }]
  ] as const) {
    const gone = await call(name, args);
    assert.equal(gone.isError, true);
    assert.equal(errorOf(gone).code, "CLAIM_NOT_FOUND");
  }
  assert.equal(calls.length, 2);
  assert.equal(completions.length, 0);
  await close();
});
