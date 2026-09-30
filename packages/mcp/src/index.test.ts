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

const connect = async (bridge: McpBridge) => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await bridge.start();
  await bridge.server.connect(serverTransport);
  await clientTransport.start();
  const pending = new Map<number, (response: Record<string, any>) => void>();
  clientTransport.onmessage = (response) => {
    if ("id" in response) pending.get(Number(response.id))?.(response as never);
  };
  let nextId = 100;
  const request = (name: string, args: Record<string, unknown> = {}) =>
    new Promise<Record<string, any>>((resolve) => {
      const idNumber = nextId++;
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
  return { request, close: () => clientTransport.close() };
};

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { type: "agent" as const, id: uuid(900), name: "codex" };
const emptySummary = {
  cursor: "0",
  branch_id: null,
  unread_chats: [],
  tasks: [],
  handoffs: [],
  blockers_resolved: [],
  truncated: false
};
const taskItem = (n: number) => ({
  task_id: uuid(n),
  key: `ORC-${n}`,
  title: `Task ${n}`,
  status: "in_progress",
  watching: true,
  claimed_by_you: n === 1,
  unread_count: n,
  mention_count: n % 2,
  blocking_unread_count: n,
  last_read_sequence: 0,
  latest_sequence: n + 10,
  unread: []
});
const handoffItem = (n: number) => ({
  handoff_id: uuid(200 + n),
  from: actor,
  chat_id: uuid(300),
  message_id: uuid(400 + n),
  sequence: n,
  task: n === 1 ? null : { id: uuid(n), key: `ORC-${n}`, title: "T" },
  excerpt: "please take over",
  created_at: "2026-09-28T00:00:00.000Z",
  hop: 0
});
const blockerItem = (n: number) => ({
  block_id: uuid(500 + n),
  task: { id: uuid(n), key: `ORC-${n}`, title: "T" },
  resolution: "blocking_task_done",
  resolved_at: "2026-09-28T00:00:00.000Z"
});
const range = (count: number) =>
  Array.from({ length: count }, (_, index) => index + 1);
const baseClient = () => ({
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
  }
});

test("appends the attention notice after the unchanged unread_chats notice, capped at 5", async () => {
  const summaries = [
    {
      ...emptySummary,
      unread_chats: [{ chat_id: id, unread_count: 2, mention_count: 1 }],
      tasks: range(7).map(taskItem),
      handoffs: range(6).map(handoffItem),
      blockers_resolved: range(6).map(blockerItem),
      truncated: true
    },
    { ...emptySummary, blockers_resolved: [blockerItem(1)] },
    {
      ...emptySummary,
      unread_chats: [{ chat_id: id, unread_count: 1, mention_count: 0 }]
    },
    emptySummary
  ];
  let inboxCalls = 0;
  const client = {
    ...baseClient(),
    attention: {
      async summary() {
        return summaries.shift();
      }
    },
    async getInbox() {
      inboxCalls += 1;
      return { unread_chats: [] };
    }
  };
  const bridge = new McpBridge({
    client: client as never,
    integration: "codex"
  });
  const { request, close } = await connect(bridge);
  const full = (await request("list_chats")).result;
  assert.equal(full.content.length, 3);
  assert.deepEqual(JSON.parse(full.content[1].text), {
    notice: {
      type: "unread_chats",
      unread_chats: [{ chat_id: id, unread_count: 2, mention_count: 1 }]
    }
  });
  const notice = JSON.parse(full.content[2].text).notice;
  assert.equal(notice.type, "attention");
  assert.equal(notice.tasks.length, 5);
  assert.equal(notice.handoffs.length, 5);
  assert.equal(notice.blockers_resolved.length, 5);
  assert.deepEqual(notice.tasks[0], {
    task_id: uuid(1),
    key: "ORC-1",
    unread_comments: 1,
    mentions: 1,
    claimed_by_you: true,
    latest_sequence: 11
  });
  assert.deepEqual(notice.handoffs[0], {
    handoff_id: uuid(201),
    from: { type: "agent", name: "codex" },
    task_key: null
  });
  assert.equal(notice.handoffs[1].task_key, "ORC-2");
  assert.deepEqual(notice.blockers_resolved[0], {
    block_id: uuid(501),
    task_key: "ORC-1",
    resolution: "blocking_task_done"
  });
  assert.equal(
    notice.hint,
    "Read with get_attention; acknowledge with acknowledge_attention."
  );
  assert.equal(notice.branch_id, null);
  const attentionOnly = (await request("list_chats")).result;
  assert.equal(attentionOnly.content.length, 2);
  assert.equal(
    JSON.parse(attentionOnly.content[1].text).notice.type,
    "attention"
  );
  const chatsOnly = (await request("list_chats")).result;
  assert.equal(chatsOnly.content.length, 2);
  assert.equal(
    JSON.parse(chatsOnly.content[1].text).notice.type,
    "unread_chats"
  );
  const quiet = (await request("list_chats")).result;
  assert.equal(quiet.content.length, 1);
  assert.equal(inboxCalls, 0);
  await close();
});

test("falls back to the chat inbox once the attention route 404s and remembers it", async () => {
  let summaryCalls = 0;
  let inboxCalls = 0;
  const client = {
    ...baseClient(),
    attention: {
      async summary() {
        summaryCalls += 1;
        throw new AgentApiError(404, "NOT_FOUND", "Route not found.");
      }
    },
    async getInbox() {
      inboxCalls += 1;
      return {
        unread_chats: [{ chat_id: id, unread_count: 3, mention_count: 0 }]
      };
    }
  };
  const bridge = new McpBridge({
    client: client as never,
    integration: "codex"
  });
  const { request, close } = await connect(bridge);
  for (let call = 0; call < 3; call += 1) {
    const result = (await request("list_chats")).result;
    assert.equal(result.content.length, 2);
    assert.deepEqual(JSON.parse(result.content[1].text), {
      notice: {
        type: "unread_chats",
        unread_chats: [{ chat_id: id, unread_count: 3, mention_count: 0 }]
      }
    });
  }
  assert.equal(summaryCalls, 1);
  assert.equal(inboxCalls, 3);
  await close();
});

test("other attention failures drop the notice without falling back", async () => {
  let summaryCalls = 0;
  let inboxCalls = 0;
  const client = {
    ...baseClient(),
    attention: {
      async summary() {
        summaryCalls += 1;
        throw new AgentApiError(500, "INTERNAL_ERROR", "Broken.");
      }
    },
    async getInbox() {
      inboxCalls += 1;
      return { unread_chats: [] };
    }
  };
  const bridge = new McpBridge({
    client: client as never,
    integration: "codex"
  });
  const { request, close } = await connect(bridge);
  const first = (await request("list_chats")).result;
  const second = (await request("list_chats")).result;
  assert.equal(first.content.length, 1);
  assert.equal(second.content.length, 1);
  assert.equal(summaryCalls, 2);
  assert.equal(inboxCalls, 0);
  await close();
});

test("bounds the attention read, aborts it, and preserves tool errors", async () => {
  let aborted = false;
  const client = {
    ...baseClient(),
    async getProject() {
      throw new AgentApiError(500, "BROKEN", "Main operation failed.");
    },
    attention: {
      summary(signal: AbortSignal) {
        return new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
      }
    }
  };
  const bridge = new McpBridge({
    client: client as never,
    integration: "codex",
    inboxTimeoutMs: 5
  });
  const started = Date.now();
  const internals = bridge as unknown as {
    call: (
      operation: () => Promise<unknown>
    ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
    activeClient: () => { getProject: () => Promise<unknown> };
  };
  const result = await internals.call(() =>
    internals.activeClient().getProject()
  );
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.match(result.content[0]!.text, /BROKEN/);
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 500);
  await bridge.stop();
});

test("keeps attention notices bound to the project used by an in-flight tool", async () => {
  const firstProject = "00000000-0000-4000-8000-000000000011";
  const secondProject = "00000000-0000-4000-8000-000000000012";
  let releaseFirstList: (() => void) | undefined;
  const makeClient = (name: "first" | "second") => ({
    ...baseClient(),
    async listChats() {
      if (name === "first")
        await new Promise<void>((resolve) => {
          releaseFirstList = resolve;
        });
      return { chats: [] };
    },
    attention: {
      async summary() {
        return {
          ...emptySummary,
          tasks: [taskItem(name === "first" ? 1 : 2)]
        };
      }
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
  const { request, close } = await connect(bridge);
  const taskKey = (result: Record<string, any>) =>
    JSON.parse(result.result.content[1].text).notice.tasks[0].key;
  assert.equal(
    taskKey(await request("select_project", { project_id: firstProject })),
    "ORC-1"
  );
  const firstList = request("list_chats");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    taskKey(await request("select_project", { project_id: secondProject })),
    "ORC-2"
  );
  releaseFirstList?.();
  assert.equal(taskKey(await firstList), "ORC-1");
  await close();
});

for (const [tool, method] of [
  ["complete_task", "completeClaim"],
  ["release_task", "releaseClaim"]
] as const)
  test(`${tool} passes acknowledged_through and keeps the local token on TASK_COMMENTS_UNREAD`, async () => {
    const token = "c".repeat(40);
    const mutations: unknown[] = [];
    const details = {
      task_id: id,
      latest_sequence: 7,
      total_unread: 1,
      unread: [
        {
          sequence: 7,
          author: actor,
          excerpt: "wait, the schema changed",
          created_at: "2026-09-28T00:00:00.000Z"
        }
      ]
    };
    const client = {
      ...baseClient(),
      async claimTask() {
        return { claim: { task_id: id }, claim_token: token };
      },
      async [method](sessionId: string, input: Record<string, unknown>) {
        mutations.push({ sessionId, ...input });
        if (input.acknowledged_through === undefined)
          throw new AgentApiError(
            409,
            "TASK_COMMENTS_UNREAD",
            "Read the new comments first.",
            details,
            "req_unread"
          );
        return { claim: { task_id: id, status: "done" } };
      }
    };
    const bridge = new McpBridge({
      client: client as never,
      integration: "codex"
    });
    const { request, close } = await connect(bridge);
    assert.equal(
      (await request("claim_task", { task_id: id })).result.isError,
      undefined
    );
    const refused = (await request(tool, { task_id: id })).result;
    assert.equal(refused.isError, true);
    assert.deepEqual(JSON.parse(refused.content[0].text), {
      error: {
        code: "TASK_COMMENTS_UNREAD",
        message: "Read the new comments first.",
        details,
        request_id: "req_unread"
      }
    });
    assert.equal(bridge.claims.get(id), token);
    const invalid = (
      await request(tool, { task_id: id, acknowledged_through: -1 })
    ).result;
    assert.equal(invalid.isError, true);
    assert.equal(mutations.length, 1);
    const done = (await request(tool, { task_id: id, acknowledged_through: 7 }))
      .result;
    assert.equal(done.isError, undefined);
    assert.deepEqual(mutations, [
      { sessionId: id, claim_token: token },
      { sessionId: id, claim_token: token, acknowledged_through: 7 }
    ]);
    assert.equal(bridge.claims.get(id), undefined);
    await close();
  });

test("drops malformed TASK_COMMENTS_UNREAD details", () => {
  const result = mapMcpError(
    new AgentApiError(409, "TASK_COMMENTS_UNREAD", "Unread.", {
      task_id: "not-a-uuid"
    })
  );
  assert.deepEqual(JSON.parse(result.content[0]!.text), {
    error: { code: "TASK_COMMENTS_UNREAD", message: "Unread." }
  });
});
