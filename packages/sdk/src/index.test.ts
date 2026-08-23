import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentApiClient,
  AgentApiError,
  validateAgentApiBaseUrl
} from "./index.js";

const id = "00000000-0000-4000-8000-000000000001";
const timestamp = "2026-08-22T00:00:00.000Z";
const token = `orch_agent_${"x".repeat(32)}`;
const session = {
  id,
  agent_id: id,
  project_id: id,
  runtime: "codex",
  integration: "codex",
  external_session_id: null,
  status: "active",
  started_at: timestamp,
  ended_at: null,
  last_heartbeat_at: timestamp
};

test("accepts HTTPS roots and loopback HTTP only", () => {
  assert.equal(
    validateAgentApiBaseUrl("https://api.test/"),
    "https://api.test"
  );
  assert.equal(
    validateAgentApiBaseUrl("http://127.0.0.1:3000/"),
    "http://127.0.0.1:3000"
  );
  for (const value of [
    "http://api.test",
    "https://api.test/path",
    "https://user:pass@api.test",
    "https://api.test?token=secret",
    "https://api.test#fragment"
  ])
    assert.throws(() => validateAgentApiBaseUrl(value));
});

test("parses success and structured errors without leaking credentials", async () => {
  const calls: Array<{ url: RequestInfo | URL; init?: RequestInit }> = [];
  const client = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ session }), { status: 201 });
    }
  });
  assert.deepEqual(
    (await client.openSession({ runtime: "codex", integration: "codex" }))
      .session.id,
    id
  );
  const headers = calls[0]!.init!.headers as Record<string, string>;
  assert.match(headers.authorization, /orch_agent_/);

  const malformed = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    fetch: async () => new Response(JSON.stringify({ session: {} }))
  });
  await assert.rejects(
    () => malformed.closeSession(id),
    (error: unknown) =>
      error instanceof AgentApiError &&
      error.code === "INTERNAL_ERROR" &&
      !error.message.includes(token)
  );

  const failing = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "CLAIM_NOT_OWNER",
            message: "No",
            details: {},
            request_id: "req_1"
          }
        }),
        { status: 403 }
      )
  });
  await assert.rejects(
    () => failing.closeSession(id),
    (error: unknown) =>
      error instanceof AgentApiError &&
      error.code === "CLAIM_NOT_OWNER" &&
      !error.message.includes(token)
  );
});

test("retries only a safe GET transport failure", async () => {
  let attempts = 0;
  const client = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    sleep: async () => {},
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return new Response(JSON.stringify({ agents: [] }));
    }
  });
  assert.deepEqual(await client.getPresence(), { agents: [] });
  assert.equal(attempts, 2);

  attempts = 0;
  const malformed = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    sleep: async () => {},
    fetch: async () => {
      attempts += 1;
      return new Response(JSON.stringify({ agents: [{}] }));
    }
  });
  await assert.rejects(() => malformed.getPresence(), /invalid response/);
  assert.equal(attempts, 1);

  attempts = 0;
  const noRetry = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    sleep: async () => {},
    fetch: async () => {
      attempts += 1;
      throw new Error("offline");
    }
  });
  await assert.rejects(() => noRetry.closeSession(id), /API request failed/);
  assert.equal(attempts, 1);
});
