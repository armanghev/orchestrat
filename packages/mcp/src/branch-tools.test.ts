import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION
} from "@modelcontextprotocol/server";
import { AgentApiError } from "@orchestrat/sdk";
import { McpBridge, type BridgeOptions, type CheckoutBranch } from "./index.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const ids = {
  main: "00000000-0000-4000-8000-0000000000a0",
  "feat/a": "00000000-0000-4000-8000-0000000000a1",
  "feat/b": "00000000-0000-4000-8000-0000000000a2",
  "feat/old": "00000000-0000-4000-8000-0000000000a3"
} as const;
const task = "00000000-0000-4000-8000-0000000000f1";
type Name = keyof typeof ids;
const nameOf = (id: string) =>
  (Object.keys(ids) as Name[]).find((name) => ids[name] === id)!;

// A fake API with real branch semantics: clients carry the branch and session
// headers as state, sessions pin a branch, and a close can be made to fail.
function fakeApi() {
  const state = {
    log: [] as string[],
    sessions: new Map<string, { branch: Name; status: string }>(),
    archived: new Set<Name>(["feat/old"]),
    failClose: false,
    failOpen: false,
    nextSession: 1
  };
  const branch = (name: Name) => ({
    id: ids[name],
    project_id: projectId,
    name,
    is_default: name === "main",
    name_source: "cli",
    created_via: "cli",
    created_by: null,
    onboarding_state: "completed",
    onboarding_choice: null,
    archived_at: state.archived.has(name) ? "2026-09-30T00:00:00.000Z" : null,
    archived_reason: state.archived.has(name) ? "manual" : null,
    provider: null,
    open_decision_count: 0,
    created_at: "2026-09-30T00:00:00.000Z",
    updated_at: "2026-09-30T00:00:00.000Z"
  });
  const make = (branchId?: string, sessionId?: string): any => ({
    branchId,
    sessionId,
    withBranch: (id: string | undefined) => make(id, undefined),
    withSession: (id: string | undefined) => make(branchId, id),
    async openSession(input: { branch_id?: string }) {
      if (state.failOpen)
        throw new AgentApiError(503, "INTERNAL_ERROR", "down");
      const name = nameOf(input.branch_id ?? branchId ?? ids.main);
      const id = `00000000-0000-4000-8000-${String(state.nextSession++).padStart(12, "0")}`;
      state.sessions.set(id, { branch: name, status: "active" });
      state.log.push(`open:${name}`);
      return { session: { id, branch_id: ids[name] } };
    },
    async closeSession(id: string) {
      if (state.failClose)
        throw new AgentApiError(503, "INTERNAL_ERROR", "down");
      state.sessions.get(id)!.status = "closed";
      state.log.push(`close:${state.sessions.get(id)!.branch}`);
      return {};
    },
    async heartbeat() {
      return {};
    },
    async getProject() {
      return { id: projectId, default_branch_id: ids.main };
    },
    // Echoes where the call was bound: the session's pin wins, like the API.
    async listTasks() {
      const pinned = sessionId && state.sessions.get(sessionId);
      return {
        tasks: [],
        next_cursor: null,
        branch: pinned ? pinned.branch : nameOf(branchId ?? ids.main)
      };
    },
    async claimTask(taskId: string) {
      const pinned = sessionId && state.sessions.get(sessionId);
      if (pinned && state.archived.has(pinned.branch))
        throw new AgentApiError(
          409,
          "BRANCH_ARCHIVED",
          "This branch is archived."
        );
      return { claim: { task_id: taskId }, claim_token: "claim-token" };
    },
    branches: {
      async list(query: { name?: string; include_archived?: boolean } = {}) {
        return {
          branches: (Object.keys(ids) as Name[])
            .filter((name) => !query.name || name === query.name)
            .filter(
              (name) => query.include_archived || !state.archived.has(name)
            )
            .map(branch)
        };
      },
      async get(id: string) {
        return { branch: branch(nameOf(id)) };
      },
      async register(input: { name: Name }) {
        state.log.push(`register:${input.name}`);
        if (state.archived.has(input.name))
          throw new AgentApiError(409, "BRANCH_ARCHIVED", "Archived.", {
            branch_id: ids[input.name]
          });
        return { branch: branch(input.name), created: false };
      }
    }
  });
  return { state, client: make() };
}

async function connect(options: Omit<BridgeOptions, "integration">) {
  const bridge = new McpBridge({ integration: "codex", ...options });
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
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await rpc("tools/call", { name, arguments: args })).result;
    const [first, ...rest] = result.content.map(
      (item: { text: string }) => JSON.parse(item.text) as Record<string, any>
    );
    return {
      isError: result.isError === true,
      body: first!,
      notices: rest.map((item: { notice: unknown }) => item.notice)
    };
  };
  return { bridge, call, close: () => clientTransport.close() };
}

const checkout = (name: string | null): CheckoutBranch => ({
  name,
  defaultBranch: "main",
  headSha: null
});

test("follows the checkout: starts on it and switches when nothing is claimed", async () => {
  const api = fakeApi();
  let head: CheckoutBranch = checkout("feat/a");
  const { call, close } = await connect({
    client: api.client,
    resolveCheckoutBranch: async () => head
  });
  assert.deepEqual(api.state.log, ["register:feat/a", "open:feat/a"]);
  assert.equal((await call("list_tasks")).body.branch, "feat/a");

  head = checkout("feat/b");
  const switched = await call("list_tasks");
  assert.equal(
    switched.body.branch,
    "feat/b",
    "the call ran on the new branch"
  );
  assert.deepEqual(switched.notices, [
    { type: "branch_switched", from: "feat/a", to: "feat/b" }
  ]);
  assert.deepEqual(api.state.log.slice(2), [
    "register:feat/b",
    "close:feat/a",
    "open:feat/b"
  ]);
  const project = (await call("get_project")).body;
  assert.deepEqual(project, {
    id: projectId,
    default_branch_id: ids.main,
    branch: { id: ids["feat/b"], name: "feat/b", is_default: false },
    follow_checkout: true
  });
  const listed = (await call("list_branches")).body;
  assert.deepEqual(
    listed.branches.map((branch: { name: string; is_current: boolean }) => [
      branch.name,
      branch.is_current
    ]),
    [
      ["main", false],
      ["feat/a", false],
      ["feat/b", true]
    ]
  );
  await close();
});

test("active claims hold the session and report a mismatch instead", async () => {
  const api = fakeApi();
  let head = checkout("feat/a");
  const { bridge, call, close } = await connect({
    client: api.client,
    resolveCheckoutBranch: async () => head
  });
  await call("claim_task", { task_id: task });
  head = checkout("feat/b");
  const held = await call("list_tasks");
  assert.equal(held.body.branch, "feat/a");
  assert.deepEqual(held.notices, [
    {
      type: "branch_mismatch",
      checkout: "feat/b",
      session: "feat/a",
      active_claims: [task]
    }
  ]);
  assert.deepEqual(bridge.claims.taskIds(), [task]);
  await close();
});

test("a failed close keeps the session, claims and heartbeat; a retry switches", async () => {
  const api = fakeApi();
  const { bridge, call, close } = await connect({ client: api.client });
  await call("claim_task", { task_id: task });
  const before = (bridge as unknown as { sessionId: string }).sessionId;
  api.state.failClose = true;
  const failed = await call("select_branch", { branch: "feat/b" });
  assert.equal(failed.isError, true);
  assert.equal(failed.body.error.code, "INTERNAL_ERROR");
  assert.equal(
    (bridge as unknown as { sessionId: string }).sessionId,
    before,
    "the session is kept"
  );
  assert.deepEqual(bridge.claims.taskIds(), [task], "claim tokens are kept");
  assert.ok(
    (bridge as unknown as { heartbeatTimer?: unknown }).heartbeatTimer,
    "the heartbeat keeps running"
  );
  assert.equal((await call("list_tasks")).body.branch, "main");

  api.state.failClose = false;
  const switched = await call("select_branch", { branch: "feat/b" });
  assert.deepEqual(switched.body, {
    branch: { id: ids["feat/b"], name: "feat/b", is_default: false },
    released_claim_task_ids: [task],
    follow_checkout: false
  });
  assert.deepEqual(bridge.claims.taskIds(), []);
  assert.equal((await call("list_tasks")).body.branch, "feat/b");
  await close();
});

test("an open failure leaves no session until select_branch succeeds", async () => {
  const api = fakeApi();
  const { call, close } = await connect({ client: api.client });
  api.state.failOpen = true;
  const failed = await call("select_branch", { branch: "feat/a" });
  assert.equal(failed.isError, true);
  const claim = await call("claim_task", { task_id: task });
  assert.equal(claim.body.error.code, "AGENT_SESSION_NOT_FOUND");
  api.state.failOpen = false;
  const again = await call("select_branch", { branch: "feat/a" });
  assert.equal(again.isError, false);
  assert.equal((await call("list_tasks")).body.branch, "feat/a");
  await close();
});

test("select_branch finds, creates and refuses branches, then can follow again", async () => {
  const api = fakeApi();
  let head = checkout("feat/a");
  const { call, close } = await connect({
    client: api.client,
    resolveCheckoutBranch: async () => head
  });
  const missing = await call("select_branch", { branch: "nope" });
  assert.equal(missing.body.error.code, "BRANCH_NOT_FOUND");
  const archived = await call("select_branch", { branch: ids["feat/old"] });
  assert.equal(archived.body.error.code, "BRANCH_ARCHIVED");
  const both = await call("select_branch", {
    branch: "feat/b",
    follow_checkout: true
  });
  assert.equal(both.body.error.code, "VALIDATION_ERROR");

  const manual = await call("select_branch", { branch: "feat/b" });
  assert.equal(manual.body.follow_checkout, false);
  head = checkout("main");
  const stays = await call("list_tasks");
  assert.equal(stays.body.branch, "feat/b", "manual mode ignores the checkout");
  assert.deepEqual(stays.notices, []);
  const same = await call("select_branch", { branch: "feat/b" });
  assert.deepEqual(same.body.released_claim_task_ids, []);

  const following = await call("select_branch", { follow_checkout: true });
  assert.deepEqual(following.body.branch, {
    id: ids.main,
    name: "main",
    is_default: true
  });
  assert.equal(following.body.follow_checkout, true);
  await close();
});

test("an archived checkout branch works on the default branch and says so", async () => {
  const api = fakeApi();
  const { call, close } = await connect({
    client: api.client,
    resolveCheckoutBranch: async () => checkout("feat/old")
  });
  assert.deepEqual(api.state.log, ["register:feat/old", "open:main"]);
  for (let round = 0; round < 2; round++) {
    const result = await call("list_tasks");
    assert.equal(result.body.branch, "main");
    assert.equal(result.notices[0].type, "branch_archived");
    assert.equal(result.notices[0].branch, "feat/old");
  }
  assert.equal(
    api.state.log.filter((entry) => entry === "register:feat/old").length,
    1,
    "the refusal is remembered, not re-requested every call"
  );
  await close();
});

test("a detached HEAD keeps the branch and notices once", async () => {
  const api = fakeApi();
  let head = checkout("feat/a");
  const { call, close } = await connect({
    client: api.client,
    resolveCheckoutBranch: async () => head
  });
  head = checkout(null);
  const first = await call("list_tasks");
  assert.equal(first.body.branch, "feat/a");
  assert.deepEqual(first.notices, [
    { type: "checkout_detached", working_on: "feat/a" }
  ]);
  assert.deepEqual((await call("list_tasks")).notices, []);
  await close();
});

test("a call in flight keeps the branch it started on", async () => {
  const api = fakeApi();
  let release: (() => void) | undefined;
  const client = api.client;
  const originalWithBranch = client.withBranch;
  // The feat/a client blocks its listTasks until released.
  client.withBranch = (id: string | undefined) => {
    const scoped = originalWithBranch(id);
    const withSession = scoped.withSession;
    scoped.withSession = (session: string) => {
      const pinned = withSession(session);
      if (id === ids["feat/a"]) {
        const list = pinned.listTasks;
        pinned.listTasks = async () => {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return list();
        };
      }
      return pinned;
    };
    return scoped;
  };
  const { call, close } = await connect({ client });
  await call("select_branch", { branch: "feat/a" });
  const inFlight = call("list_tasks");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await call("select_branch", { branch: "feat/b" });
  release?.();
  assert.equal((await inFlight).body.branch, "feat/a");
  assert.equal((await call("list_tasks")).body.branch, "feat/b");
  await close();
});

test("an API or client without branches behaves exactly as before", async () => {
  const opened: unknown[] = [];
  const legacy = {
    async openSession(input: unknown) {
      opened.push(input);
      return { session: { id: projectId } };
    },
    async heartbeat() {
      return {};
    },
    async closeSession() {
      return {};
    },
    async getProject() {
      return { id: projectId };
    }
  };
  const { call, close } = await connect({
    client: legacy as never,
    resolveCheckoutBranch: async () => checkout("feat/a")
  });
  assert.deepEqual(opened, [{ runtime: "codex", integration: "codex" }]);
  const project = await call("get_project");
  assert.deepEqual(project.body, { id: projectId });
  assert.deepEqual(project.notices, []);
  const select = await call("select_branch", { branch: "feat/a" });
  assert.equal(select.body.error.code, "NOT_FOUND");
  await close();
});

test("a branch archived mid-session moves a follower to the default branch", async () => {
  const api = fakeApi();
  const { call, close } = await connect({
    client: api.client,
    resolveCheckoutBranch: async () => checkout("feat/a")
  });
  api.state.archived.add("feat/a");
  const refused = await call("claim_task", { task_id: task });
  assert.equal(refused.body.error.code, "BRANCH_ARCHIVED");
  assert.equal(refused.notices[0].type, "branch_archived");
  assert.deepEqual(api.state.log.slice(-2), ["close:feat/a", "open:main"]);
  const next = await call("list_tasks");
  assert.equal(next.body.branch, "main");
  assert.equal(next.notices[0].type, "branch_archived");
  await close();
});

test("a manual session on an archived branch is told to select another", async () => {
  const api = fakeApi();
  const { call, close } = await connect({ client: api.client });
  await call("select_branch", { branch: "feat/b" });
  api.state.archived.add("feat/b");
  const refused = await call("claim_task", { task_id: task });
  assert.deepEqual(refused.notices, [
    {
      type: "branch_archived",
      branch: "feat/b",
      hint: "This branch was archived; call select_branch."
    }
  ]);
  assert.equal(api.state.log.at(-1), "open:feat/b", "no automatic switch");
  await close();
});
