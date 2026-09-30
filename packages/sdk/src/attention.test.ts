import assert from "node:assert/strict";
import test from "node:test";
import { unreadCommentsErrorDetailsSchema } from "@orchestrat/protocol";
import { AgentApiClient, AgentApiError } from "./index.js";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const timestamp = "2026-09-28T00:00:00.000Z";
const token = `orch_agent_${"x".repeat(32)}`;
const claimToken = "c".repeat(32);
const actor = { type: "agent" as const, id, name: "Codex" };
const taskRef = { id, key: "ORC-7", title: "Contracts" };

const summary = {
  cursor: "42",
  branch_id: null,
  unread_chats: [],
  tasks: [],
  handoffs: [],
  blockers_resolved: [],
  truncated: false
};
const block = {
  id: other,
  task_id: id,
  reason: "Waiting on the API",
  blocking_task: null,
  blocked_on: actor,
  created_by: actor,
  created_at: timestamp,
  resolved_at: null,
  resolution: null
};
const handoff = {
  id: other,
  chat_id: id,
  message_id: other,
  message_sequence: 3,
  from: actor,
  to: { type: "human" as const, id: other, name: "Arman" },
  task: taskRef,
  chain_id: id,
  hop: 0,
  created_at: timestamp
};

type Call = { url: URL; init?: RequestInit };

const fakeClient = () => {
  const calls: Call[] = [];
  const client = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    fetch: async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({ url: parsed, init });
      const path = parsed.pathname.replace("/api/v1/agent", "");
      const body =
        path === "/attention"
          ? summary
          : path === "/attention/acknowledge"
            ? { acknowledged: 2 }
            : path.endsWith("/watch")
              ? {
                  task_id: id,
                  state: "muted",
                  reason: "explicit",
                  last_read_sequence: 4
                }
              : path.endsWith("/claims/status")
                ? {
                    task: { id, key: "ORC-7", status: "blocked", version: 3 },
                    claim: {
                      id,
                      status: "active",
                      lease_expires_at: timestamp
                    },
                    block
                  }
                : path === "/attention/wait"
                  ? {
                      status: "timeout",
                      events: [],
                      cursor: "42",
                      attention: summary
                    }
                  : path === "/handoffs"
                    ? { handoff }
                    : { wake_event_id: 7 };
      return new Response(JSON.stringify(body), { status: 200 });
    }
  });
  return { client, calls };
};

const headers = (call: Call) => call.init!.headers as Record<string, string>;
const body = (call: Call) => JSON.parse(String(call.init!.body));

test("maps attention summary, acknowledge and watch routes", async () => {
  const { client, calls } = fakeClient();
  const controller = new AbortController();

  assert.equal(
    (await client.attention.summary(controller.signal)).cursor,
    "42"
  );
  assert.equal(calls[0]!.init!.method, "GET");
  assert.equal(calls[0]!.url.pathname, "/api/v1/agent/attention");
  assert.equal(calls[0]!.init!.signal, controller.signal);
  assert.equal(calls[0]!.init!.body, undefined);

  const acknowledged = await client.attention.acknowledge({
    items: [
      { type: "task_comments", task_id: id, through_sequence: 4 },
      { type: "handoff", handoff_id: other }
    ]
  });
  assert.equal(acknowledged.acknowledged, 2);
  assert.equal(calls[1]!.init!.method, "POST");
  assert.equal(calls[1]!.url.pathname, "/api/v1/agent/attention/acknowledge");
  assert.deepEqual(body(calls[1]!), {
    items: [
      { type: "task_comments", task_id: id, through_sequence: 4 },
      { type: "handoff", handoff_id: other }
    ]
  });
  assert.equal(headers(calls[1]!)["content-type"], "application/json");

  assert.equal((await client.attention.watch(id, false)).state, "muted");
  assert.equal(calls[2]!.init!.method, "POST");
  assert.equal(calls[2]!.url.pathname, `/api/v1/agent/tasks/${id}/watch`);
  assert.deepEqual(body(calls[2]!), { watching: false });

  assert.throws(() => client.attention.watch("../x", true));
  assert.throws(() => client.attention.acknowledge({ items: [] }));
  assert.equal(calls.length, 3);
});

test("maps set status, handoff and wake routes with encoded ids and keys", async () => {
  const { client, calls } = fakeClient();

  const status = await client.attention.setStatus("session/1", {
    claim_token: claimToken,
    status: "blocked",
    reason: "Waiting on the API",
    blocked_on: { type: "agent", id }
  });
  assert.equal(status.block?.id, other);
  assert.equal(calls[0]!.init!.method, "POST");
  assert.equal(
    calls[0]!.url.pathname,
    "/api/v1/agent/sessions/session%2F1/claims/status"
  );
  assert.deepEqual(body(calls[0]!), {
    claim_token: claimToken,
    status: "blocked",
    reason: "Waiting on the API",
    blocked_on: { type: "agent", id }
  });
  assert.throws(() =>
    client.attention.setStatus(id, {
      claim_token: claimToken,
      status: "blocked"
    })
  );

  const created = await client.attention.handoff(
    {
      to: { type: "human", id: other },
      body_markdown: "Over to you",
      task_id: id
    },
    "handoff-key"
  );
  assert.equal(created.handoff.id, other);
  assert.equal(calls[1]!.init!.method, "POST");
  assert.equal(calls[1]!.url.pathname, "/api/v1/agent/handoffs");
  assert.equal(headers(calls[1]!)["idempotency-key"], "handoff-key");
  assert.deepEqual(body(calls[1]!), {
    to: { type: "human", id: other },
    body_markdown: "Over to you",
    task_id: id
  });

  assert.equal(
    (
      await client.attention.recordWake({
        integration: "codex",
        handoff_id: other
      })
    ).wake_event_id,
    7
  );
  assert.equal(calls[2]!.init!.method, "POST");
  assert.equal(calls[2]!.url.pathname, "/api/v1/agent/wakes");
  assert.equal(headers(calls[2]!)["idempotency-key"], undefined);
  assert.deepEqual(body(calls[2]!), {
    integration: "codex",
    handoff_id: other
  });
});

test("builds the wait query string and forwards the abort signal", async () => {
  const { client, calls } = fakeClient();
  const controller = new AbortController();

  const response = await client.attention.wait(
    {
      after: "41",
      timeout_ms: 5000,
      directed_only: true,
      kinds: ["mention", "handoff"],
      branch_id: other
    },
    controller.signal
  );
  assert.equal(response.status, "timeout");
  assert.equal(calls[0]!.init!.method, "GET");
  assert.equal(calls[0]!.url.pathname, "/api/v1/agent/attention/wait");
  assert.equal(calls[0]!.init!.signal, controller.signal);
  assert.deepEqual(Object.fromEntries(calls[0]!.url.searchParams), {
    after: "41",
    timeout_ms: "5000",
    directed_only: "true",
    kinds: "mention,handoff",
    branch_id: other
  });

  await client.attention.wait();
  assert.deepEqual(Object.fromEntries(calls[1]!.url.searchParams), {
    timeout_ms: "25000",
    directed_only: "false"
  });
  assert.throws(() => client.attention.wait({ after: "x" }));
  assert.equal(calls.length, 2);
});

test("aborting a wait surfaces a network error without retrying", async () => {
  const seen: Array<boolean | undefined> = [];
  const client = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    sleep: async () => {},
    fetch: async (_url, init) => {
      seen.push(init?.signal?.aborted);
      throw new DOMException("Aborted", "AbortError");
    }
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => client.attention.wait({}, controller.signal),
    (error: unknown) =>
      error instanceof AgentApiError && error.code === "NETWORK_ERROR"
  );
  assert.deepEqual(seen, [true]);
});

test("parses TASK_COMMENTS_UNREAD errors with their unread details", async () => {
  const details = {
    task_id: id,
    latest_sequence: 5,
    total_unread: 1,
    unread: [
      {
        sequence: 5,
        author: actor,
        excerpt: "Rename the field first.",
        created_at: timestamp
      }
    ]
  };
  const client = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "TASK_COMMENTS_UNREAD",
            message: "Read the new comments before ending the claim.",
            details,
            request_id: "req_unread"
          }
        }),
        { status: 409 }
      )
  });
  await assert.rejects(
    () =>
      client.attention.setStatus(id, {
        claim_token: claimToken,
        status: "review"
      }),
    (error: unknown) =>
      error instanceof AgentApiError &&
      error.status === 409 &&
      error.code === "TASK_COMMENTS_UNREAD" &&
      error.requestId === "req_unread" &&
      unreadCommentsErrorDetailsSchema.parse(error.details).unread[0]!
        .sequence === 5
  );
  await assert.rejects(
    () =>
      client.completeClaim(id, {
        claim_token: claimToken,
        acknowledged_through: 4
      }),
    (error: unknown) =>
      error instanceof AgentApiError &&
      error.code === "TASK_COMMENTS_UNREAD" &&
      (error.details as { total_unread?: number }).total_unread === 1
  );
});
