import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION
} from "@modelcontextprotocol/server";
import { AgentApiError } from "@orchestrat/sdk";
import { ClaimTokenStore, McpBridge, mapMcpError } from "./index.js";

const id = "00000000-0000-4000-8000-000000000001";

test("claim tokens stay in memory and are one-shot", () => {
  const store = new ClaimTokenStore();
  store.set({ task_id: id }, "secret-claim-token");
  assert.equal(store.take(id), "secret-claim-token");
  assert.equal(store.take(id), undefined);
});

test("maps agent errors without inputs or stacks", () => {
  const result = mapMcpError(
    new AgentApiError(
      409,
      "TASK_ALREADY_CLAIMED",
      "Task is already claimed.",
      {},
      "req_1"
    )
  );
  const text = result.content[0]!.text;
  assert.deepEqual(JSON.parse(text), {
    error: {
      code: "TASK_ALREADY_CLAIMED",
      message: "Task is already claimed.",
      request_id: "req_1"
    }
  });
  assert.equal("stack" in result, false);
});

test("opens, heartbeats, and closes one session", async () => {
  const calls: string[] = [];
  const client = {
    async openSession() {
      calls.push("open");
      return { session: { id } };
    },
    async heartbeat() {
      calls.push("heartbeat");
      return {};
    },
    async closeSession() {
      calls.push("close");
      return {};
    },
    async listTasks() {
      return {};
    },
    async getTask() {
      return {};
    },
    async claimTask() {
      return {};
    },
    async releaseClaim() {
      return {};
    },
    async completeClaim() {
      return {};
    },
    async listEvents() {
      return {};
    },
    async listDocuments() {
      return { documents: [], next_cursor: null };
    },
    async readDocument() {
      return {};
    },
    async createDocument() {
      return { document: {}, revision: {} };
    },
    async updateDocument() {
      throw new AgentApiError(
        409,
        "DOCUMENT_CONFLICT",
        "Document revision is stale.",
        { current_revision: 2, base_revision: 1 }
      );
    }
  };
  const bridge = new McpBridge({
    client: client as never,
    integration: "codex",
    heartbeatMs: 5
  });
  await bridge.start();
  await new Promise((resolve) => setTimeout(resolve, 15));
  await bridge.stop();
  await bridge.stop();
  assert.equal(calls[0], "open");
  assert.equal(calls.at(-1), "close");
  assert.equal(calls.filter((call) => call === "close").length, 1);
  assert.ok(calls.includes("heartbeat"));
});

test("invokes a registered tool over the official in-memory transport", async () => {
  const calls: unknown[] = [];
  const client = {
    async openSession() {
      return { session: { id } };
    },
    async heartbeat() {
      return {};
    },
    async closeSession() {
      calls.push("close");
      return {};
    },
    async listTasks(query: unknown) {
      calls.push(query);
      return { tasks: [], total: 0, next_cursor: null };
    },
    async getTask() {
      return {};
    },
    async claimTask() {
      return {};
    },
    async releaseClaim() {
      return {};
    },
    async completeClaim() {
      return {};
    },
    async listEvents() {
      return {};
    },
    async listDocuments() {
      return { documents: [], next_cursor: null };
    },
    async readDocument() {
      return {};
    },
    async createDocument(input: unknown) {
      calls.push({ create: input });
      return { document: {}, revision: {} };
    },
    async updateDocument(_documentId: string, input: unknown) {
      calls.push({ update: input });
      throw new AgentApiError(
        409,
        "DOCUMENT_CONFLICT",
        "Document revision is stale.",
        { current_revision: 2, base_revision: 1 }
      );
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
  const request = (message: Record<string, unknown>) =>
    new Promise<Record<string, any>>((resolve) => {
      clientTransport.onmessage = (response) => {
        if ("id" in response && response.id === message.id)
          resolve(response as Record<string, any>);
      };
      void clientTransport.send(message as never);
    });
  await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test", version: "1" }
    }
  });
  await clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  } as never);
  const result = await request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list_tasks", arguments: { limit: 3 } }
  });
  assert.deepEqual(calls, [{ limit: 3 }]);
  assert.equal(result.result.isError, undefined);
  const created = await request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "create_document",
      arguments: { path: "docs/README.md", content: "hello" }
    }
  });
  assert.equal(created.result.isError, undefined);
  const stale = await request({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "update_document",
      arguments: { document_id: id, content: "overwrite", base_revision: 1 }
    }
  });
  assert.equal(stale.result.isError, true);
  assert.match(stale.result.content[0].text, /DOCUMENT_CONFLICT/);
  assert.match(stale.result.content[0].text, /current_revision/);
  await clientTransport.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.at(-1), "close");
});
