import assert from "node:assert/strict";
import test from "node:test";
import { AgentApiClient } from "./index.js";

const id = "00000000-0000-4000-8000-000000000001";
const branchId = "00000000-0000-4000-8000-0000000000b1";
const sessionId = "00000000-0000-4000-8000-0000000000c1";
const timestamp = "2026-09-30T00:00:00.000Z";
const token = `orch_agent_${"x".repeat(32)}`;
const session = {
  id: sessionId,
  agent_id: id,
  project_id: id,
  branch_id: branchId,
  runtime: "codex",
  integration: "codex",
  external_session_id: null,
  status: "active",
  started_at: timestamp,
  ended_at: null,
  last_heartbeat_at: timestamp
};
const branch = {
  id: branchId,
  project_id: id,
  name: "feat/login",
  is_default: false,
  name_source: "cli",
  created_via: "cli",
  created_by: { type: "agent", id },
  onboarding_state: "pending",
  onboarding_choice: null,
  archived_at: null,
  archived_reason: null,
  provider: null,
  open_decision_count: 0,
  created_at: timestamp,
  updated_at: timestamp
};

type Call = { url: string; method: string; headers: Record<string, string> };

const recorder = (body: unknown, status = 200) => {
  const calls: Array<Call & { body?: unknown }> = [];
  const client = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        method: init!.method!,
        headers: init!.headers as Record<string, string>,
        body: init!.body ? JSON.parse(String(init!.body)) : undefined
      });
      return new Response(JSON.stringify(body), { status });
    }
  });
  return { client, calls };
};

test("without a branch the client sends exactly the old headers", async () => {
  const { client, calls } = recorder({ chats: [] });
  await client.listChats();
  assert.deepEqual(calls[0]!.headers, { authorization: `Bearer ${token}` });
  assert.equal(client.branchId, undefined);
  assert.equal(client.sessionId, undefined);
});

test("branch and session headers ride on every request of a copy", async () => {
  const { client, calls } = recorder({ chats: [] });
  const onBranch = client.withBranch(branchId);
  const pinned = onBranch.withSession(sessionId);
  await onBranch.listChats();
  await pinned.listChats();
  await client.listChats();
  assert.deepEqual(calls[0]!.headers, {
    authorization: `Bearer ${token}`,
    "x-orchestrat-branch-id": branchId
  });
  assert.deepEqual(calls[1]!.headers, {
    authorization: `Bearer ${token}`,
    "x-orchestrat-branch-id": branchId,
    "x-orchestrat-session-id": sessionId
  });
  assert.deepEqual(
    calls[2]!.headers,
    { authorization: `Bearer ${token}` },
    "copies never change the original client"
  );
  assert.equal(pinned.branchId, branchId);
  assert.equal(pinned.sessionId, sessionId);
  const moved = pinned.withBranch(undefined);
  assert.equal(moved.sessionId, undefined, "a branch switch drops the pin");
  assert.equal(moved.branchId, undefined);
});

test("openSession pins the client's branch unless the input names one", async () => {
  const other = "00000000-0000-4000-8000-0000000000b2";
  const { client, calls } = recorder({ session }, 201);
  const onBranch = client.withBranch(branchId);
  const opened = await onBranch.openSession({
    runtime: "codex",
    integration: "codex"
  });
  assert.equal(opened.session.branch_id, branchId);
  await onBranch.openSession({
    runtime: "codex",
    integration: "codex",
    branch_id: other
  });
  await client.openSession({ runtime: "codex", integration: "codex" });
  assert.deepEqual(
    calls.map((call) => call.body),
    [
      { runtime: "codex", integration: "codex", branch_id: branchId },
      { runtime: "codex", integration: "codex", branch_id: other },
      { runtime: "codex", integration: "codex" }
    ]
  );
});

test("branch calls use exact URLs and encode names", async () => {
  const listed = recorder({ branches: [branch] });
  const branches = await listed.client.branches.list();
  assert.equal(branches.branches[0]!.name, "feat/login");
  await listed.client.branches.list({
    include_archived: true,
    name: "feat/login"
  });
  assert.deepEqual(
    listed.calls.map((call) => [call.method, call.url]),
    [
      ["GET", "https://api.test/api/v1/agent/branches"],
      [
        "GET",
        "https://api.test/api/v1/agent/branches?include_archived=true&name=feat%2Flogin"
      ]
    ]
  );

  const got = recorder({ branch });
  assert.equal((await got.client.branches.get(branchId)).branch.id, branchId);
  assert.equal(
    got.calls[0]!.url,
    `https://api.test/api/v1/agent/branches/${branchId}`
  );
  assert.throws(() => got.client.branches.get("../project"));

  const registered = recorder({ branch, created: true });
  const result = await registered.client
    .withBranch(branchId)
    .branches.register({
      name: "feat/login",
      git_default_branch: "main",
      head_sha: "0123abc",
      force_new: true
    });
  assert.equal(result.created, true);
  assert.deepEqual(registered.calls[0], {
    url: "https://api.test/api/v1/agent/branches/register",
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-orchestrat-branch-id": branchId,
      "content-type": "application/json"
    },
    body: {
      name: "feat/login",
      git_default_branch: "main",
      head_sha: "0123abc",
      force_new: true
    }
  });
  assert.throws(() =>
    registered.client.branches.register({ name: "bad name" })
  );
});

test("malformed branch or session ids fail before any request", () => {
  const { client, calls } = recorder({});
  assert.throws(() => client.withBranch("main"));
  assert.throws(() => client.withSession("not-a-session"));
  assert.equal(calls.length, 0);
});
