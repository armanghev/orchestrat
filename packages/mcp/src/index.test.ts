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
    async getProject() {
      calls.push("project");
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
    async getProject() {
      calls.push("project");
      return {};
    },
    async createTask(input: unknown, key: string) {
      calls.push({ createTask: input, key });
      return {};
    },
    async updateTask(_id: string, input: unknown) {
      calls.push({ updateTask: input });
      throw new AgentApiError(
        409,
        "TASK_VERSION_CONFLICT",
        "Task version is stale.",
        { current_version: 2 }
      );
    },
    async listTaskComments() {
      return { comments: [], next_cursor: null };
    },
    async addTaskComment(_id: string, input: unknown, key: string) {
      calls.push({ comment: input, key });
      return {};
    },
    async listAgents() {
      return { agents: [] };
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
    },
    async editDocument(_documentId: string, input: unknown) {
      calls.push({ edit: input });
      return { document: {}, revision: {} };
    },
    async listDocumentRevisions(_documentId: string, input: unknown) {
      calls.push({ history: input });
      return { revisions: [], next_cursor: null };
    },
    async readDocumentRevision() {
      return { document: {}, revision: {} };
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
  const selectedProject = await request({
    jsonrpc: "2.0",
    id: 21,
    method: "tools/call",
    params: { name: "get_project", arguments: {} }
  });
  assert.equal(selectedProject.result.isError, undefined);
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
  const taskCreated = await request({
    jsonrpc: "2.0",
    id: 31,
    method: "tools/call",
    params: {
      name: "create_task",
      arguments: { title: "Follow up", idempotency_key: "task-key" }
    }
  });
  assert.equal(taskCreated.result.isError, undefined);
  const taskStale = await request({
    jsonrpc: "2.0",
    id: 32,
    method: "tools/call",
    params: {
      name: "update_task",
      arguments: { task_id: id, priority: "high", expected_version: 1 }
    }
  });
  assert.equal(taskStale.result.isError, true);
  assert.match(taskStale.result.content[0].text, /current_version/);
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
  const exact = await request({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "edit_document",
      arguments: {
        document_id: id,
        base_revision: 1,
        edits: [{ old_text: "hello", new_text: "updated" }]
      }
    }
  });
  assert.equal(exact.result.isError, undefined);
  const history = await request({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "list_document_revisions",
      arguments: { document_id: id, limit: 5 }
    }
  });
  assert.equal(history.result.isError, undefined);
  assert.deepEqual(calls.at(-1), { history: { limit: 5, cursor: undefined } });
  const historical = await request({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "read_document_revision",
      arguments: { document_id: id, revision: 1 }
    }
  });
  assert.equal(historical.result.isError, undefined);
  await clientTransport.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.at(-1), "close");
});

test("global Cursor requires a selected project before project tools run", async () => {
  const calls: string[] = [];
  const client = (name: string) => ({
    async openSession() {
      calls.push(`open:${name}`);
      return { session: { id: `${id}-${name}` } };
    },
    async heartbeat() {
      return {};
    },
    async closeSession() {
      calls.push(`close:${name}`);
      return {};
    },
    async listTasks() {
      calls.push(`tasks:${name}`);
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
      return {};
    }
  });
  const first = "550e8400-e29b-41d4-a716-446655440000";
  const bridge = new McpBridge({
    integration: "cursor",
    projects: [
      { id: first, name: "Org / First", client: client("first") as never },
      {
        id: "550e8400-e29b-41d4-a716-446655440001",
        name: "Org / Second",
        client: client("second") as never
      }
    ]
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
  const blocked = await request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list_tasks", arguments: {} }
  });
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /Select an Orchestrat project/);
  const selected = await request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "select_project", arguments: { project_id: first } }
  });
  assert.equal(selected.result.isError, undefined);
  await request({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "list_tasks", arguments: {} }
  });
  assert.deepEqual(calls, ["open:first", "tasks:first"]);
  await clientTransport.close();
});

test("registers messaging tools and appends an independent inbox notice", async () => {
  let inboxCalls = 0;
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
    async listChats() {
      return { chats: [] };
    },
    async listMessageCandidates() {
      return { candidates: [] };
    },
    async createChat() {
      return {};
    },
    async manageChatMembers() {
      return {};
    },
    async listChatMessages() {
      return {
        messages: [],
        has_more: false,
        next_after: null,
        next_before: null
      };
    },
    async sendMessage() {
      return {};
    },
    async acknowledgeMessages() {
      return { last_read_sequence: 0 };
    },
    async getInbox() {
      inboxCalls += 1;
      return {
        unread_chats:
          inboxCalls === 1
            ? [{ chat_id: id, unread_count: 2, mention_count: 1 }]
            : []
      };
    },
    async getProject() {
      throw new AgentApiError(403, "FORBIDDEN", "No project access.");
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
  const request = (
    idNumber: number,
    name: string,
    args: Record<string, unknown> = {}
  ) =>
    new Promise<Record<string, any>>((resolve) => {
      pending.set(idNumber, resolve);
      void clientTransport.send({
        jsonrpc: "2.0",
        id: idNumber,
        method: "tools/call",
        params: { name, arguments: args }
      } as never);
    });
  await clientTransport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test", version: "1" }
    }
  } as never);
  await clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  } as never);
  const listed = await request(2, "list_chats");
  assert.equal(listed.result.isError, undefined);
  assert.equal(listed.result.content.length, 2);
  assert.deepEqual(JSON.parse(listed.result.content[1].text), {
    notice: {
      type: "unread_chats",
      unread_chats: [{ chat_id: id, unread_count: 2, mention_count: 1 }]
    }
  });
  const candidates = await request(3, "list_message_candidates");
  assert.equal(candidates.result.content.length, 1);
  const failed = await request(4, "get_project");
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.content.length, 1);
  await clientTransport.close();
});

test("bounds inbox checks, aborts the request, and preserves tool errors", async () => {
  let aborted = false;
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
    async getProject() {
      throw new AgentApiError(500, "BROKEN", "Main operation failed.");
    },
    getInbox(signal: AbortSignal) {
      return new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    }
  };
  const bridge = new McpBridge({
    client: client as never,
    integration: "codex",
    inboxTimeoutMs: 5
  });
  const started = Date.now();
  const internals = bridge as unknown as {
    call: (operation: () => Promise<unknown>) => Promise<{ isError?: boolean }>;
    activeClient: () => { getProject: () => Promise<unknown> };
  };
  const result = await internals.call(() =>
    internals.activeClient().getProject()
  );
  assert.equal(result.isError, true);
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 500);
  await bridge.stop();
});

test("keeps inbox notices bound to the project used by an in-flight tool", async () => {
  const firstProject = "00000000-0000-4000-8000-000000000011";
  const secondProject = "00000000-0000-4000-8000-000000000012";
  let releaseFirstList: (() => void) | undefined;
  const makeClient = (name: "first" | "second") => ({
    async openSession() {
      return { session: { id: `${name}-session` } };
    },
    async heartbeat() {
      return {};
    },
    async closeSession() {
      return {};
    },
    async listChats() {
      if (name === "first")
        await new Promise<void>((resolve) => {
          releaseFirstList = resolve;
        });
      return { chats: [] };
    },
    async getInbox() {
      return {
        unread_chats: [
          {
            chat_id: id,
            unread_count: name === "first" ? 1 : 2,
            mention_count: 0
          }
        ]
      };
    }
  });
  const bridge = new McpBridge({
    integration: "cursor",
    projects: [
      { id: firstProject, name: "First", client: makeClient("first") as never },
      {
        id: secondProject,
        name: "Second",
        client: makeClient("second") as never
      }
    ]
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
  const request = (
    idNumber: number,
    name: string,
    args: Record<string, unknown> = {}
  ) =>
    new Promise<Record<string, any>>((resolve) => {
      pending.set(idNumber, resolve);
      void clientTransport.send({
        jsonrpc: "2.0",
        id: idNumber,
        method: "tools/call",
        params: { name, arguments: args }
      } as never);
    });
  await clientTransport.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test", version: "1" }
    }
  } as never);
  await clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  } as never);
  const firstSelected = await request(2, "select_project", {
    project_id: firstProject
  });
  assert.equal(
    JSON.parse(firstSelected.result.content[1].text).notice.unread_chats[0]
      .unread_count,
    1
  );
  const firstList = request(3, "list_chats");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const secondSelected = await request(4, "select_project", {
    project_id: secondProject
  });
  assert.equal(
    JSON.parse(secondSelected.result.content[1].text).notice.unread_chats[0]
      .unread_count,
    2
  );
  releaseFirstList?.();
  const firstResult = await firstList;
  assert.equal(
    JSON.parse(firstResult.result.content[1].text).notice.unread_chats[0]
      .unread_count,
    1
  );
  await clientTransport.close();
});
