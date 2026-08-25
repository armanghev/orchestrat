import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentApiClient,
  AgentApiError,
  parseAttachmentUpload,
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

test("ingests lifecycle hooks with agent auth and idempotency", async () => {
  const calls: RequestInit[] = [];
  const client = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    fetch: async (_url, init) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ event_id: 7, session }), {
        status: 200
      });
    }
  });
  await client.ingestLifecycle(
    {
      event: "session.started",
      session_id: id,
      runtime: "codex",
      integration: "codex",
      external_session_id: "provider-session"
    },
    "retry-key"
  );
  const headers = calls[0]!.headers as Record<string, string>;
  assert.equal(headers["idempotency-key"], "retry-key");
  assert.equal(headers.authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(String(calls[0]!.body)), {
    event: "session.started",
    session_id: id,
    runtime: "codex",
    integration: "codex",
    external_session_id: "provider-session"
  });
});

test("maps typed agent document routes and sends revision preconditions", async () => {
  const document = {
    id,
    project_id: id,
    path: "docs/README.md",
    current_revision: 1,
    archived_at: null,
    created_by: { type: "agent", id },
    created_at: timestamp,
    updated_at: timestamp
  };
  const revision = {
    id,
    document_id: id,
    revision_number: 1,
    content: "hello",
    author: { type: "agent", id },
    created_at: timestamp
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify(
          init?.method === "GET" &&
            new URL(String(url)).pathname.endsWith("/documents")
            ? { documents: [document], next_cursor: null }
            : { document, revision }
        ),
        { status: 200 }
      );
    }
  });
  await client.listDocuments({ limit: 1 });
  await client.readDocument(id);
  await client.createDocument({ path: "docs/README.md", content: "hello" });
  await client.updateDocument(id, { content: "updated", base_revision: 1 });
  assert.equal(
    calls[0]!.url,
    "https://api.test/api/v1/agent/documents?limit=1&include_archived=false"
  );
  assert.equal(calls[1]!.url, `https://api.test/api/v1/agent/documents/${id}`);
  assert.equal(calls[2]!.init?.method, "POST");
  assert.equal(calls[3]!.init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[3]!.init?.body)), {
    content: "updated",
    base_revision: 1
  });
});

test("supports exact edits, summary history, lifecycle, and unsigned object puts", async () => {
  const document = {
    id,
    project_id: id,
    path: "docs/README.md",
    current_revision: 1,
    archived_at: null,
    created_by: { type: "agent", id },
    created_at: timestamp,
    updated_at: timestamp
  };
  const revision = {
    id,
    document_id: id,
    revision_number: 1,
    content: "hello",
    author: { type: "agent", id },
    created_at: timestamp
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith("https://signed.test"))
        return new Response("", { status: 200, headers: { etag: "etag-1" } });
      if (String(url).includes("/revisions?"))
        return new Response(
          JSON.stringify({ revisions: [], next_cursor: null })
        );
      return new Response(JSON.stringify({ document, revision }));
    }
  });
  await client.editDocument(id, {
    base_revision: 1,
    edits: [{ old_text: "hello", new_text: "updated" }]
  });
  await client.listDocumentRevisions(id, { limit: 10 });
  await client.archiveDocument(id);
  const etag = await client.putPresignedObject(
    "https://signed.test/object",
    "body",
    "text/plain"
  );
  assert.equal(etag, "etag-1");
  assert.equal(new URL(calls[0]!.url).pathname.endsWith("/edits"), true);
  assert.match(calls[1]!.url, /view=summary/);
  const signedHeaders = calls.at(-1)!.init!.headers as Record<string, string>;
  assert.equal(signedHeaders.authorization, undefined);
});

test("parses wrapped upload sessions, completes direct uploads, and sends zero-byte PUTs", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const attachment = {
    id,
    document_id: id,
    filename: "empty.bin",
    content_type: "application/octet-stream",
    size_bytes: 0,
    created_at: timestamp
  };
  const client = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/parts"))
        return new Response(
          JSON.stringify({
            parts: [{ part_number: 1, upload_url: "https://signed.test/part" }]
          })
        );
      if (
        String(url).includes("/attachments/uploads") &&
        init?.method === "POST"
      )
        return new Response(
          JSON.stringify({
            attachment,
            upload: {
              id,
              mode: "single",
              expires_at: timestamp,
              status: "completed"
            }
          })
        );
      return new Response(
        JSON.stringify({
          upload: {
            id,
            mode: "single",
            upload_url: "https://signed.test/empty",
            expires_at: timestamp,
            completed_parts: [{ part_number: 1, etag: "etag-1" }]
          }
        })
      );
    }
  });
  const parsed = parseAttachmentUpload({
    upload: {
      id,
      mode: "multipart",
      expires_at: timestamp,
      completed_parts: [{ part_number: 2, etag: "etag-2" }]
    }
  });
  assert.equal(parsed.id, id);
  assert.deepEqual(parsed.completed_parts, [
    { part_number: 2, etag: "etag-2" }
  ]);
  const session = await client.startDocumentAttachmentUpload(id, {
    filename: "empty.bin",
    content_type: "application/octet-stream",
    size_bytes: 0
  });
  assert.equal(session.mode, "single");
  await client.putPresignedObject(
    "https://signed.test/empty",
    new Uint8Array(0),
    undefined,
    0
  );
  const completed = await client.completeDocumentAttachmentUpload(
    id,
    session.id
  );
  assert.equal(completed.attachment.size_bytes, 0);
  const parts = await client.refreshDocumentAttachmentParts(id, id, [1]);
  assert.equal(parts.parts[0]!.upload_url, "https://signed.test/part");
  assert.throws(
    () =>
      client.refreshDocumentAttachmentParts(
        id,
        id,
        Array.from({ length: 101 }, (_, index) => index + 1)
      ),
    /1-100/
  );
  const put = calls.find((call) => call.url.startsWith("https://signed.test"));
  assert.equal((put?.init?.body as Uint8Array).byteLength, 0);
});

test("resolves relative attachment download tickets against the API base", async () => {
  const client = new AgentApiClient({
    baseUrl: "https://api.test",
    token,
    fetch: async () =>
      new Response(
        JSON.stringify({
          download_url: "/api/v1/attachments/download?ticket=ticket"
        })
      )
  });
  assert.deepEqual(await client.downloadDocumentAttachment(id, id), {
    download_url: "https://api.test/api/v1/attachments/download?ticket=ticket"
  });
});
