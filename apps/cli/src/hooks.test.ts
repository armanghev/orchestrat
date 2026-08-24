import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClaudeHook } from "./claude-hooks.js";
import { normalizeCodexHook } from "./codex-hooks.js";
import { deterministicSessionId, readBoundedStdin } from "./hooks.js";
import { runHook } from "./hooks.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function* chunks(...values: (Buffer | string)[]) {
  yield* values;
}

test("provider hooks normalize supported events and stable UUIDs", () => {
  const codex = normalizeCodexHook({
    hook_event_name: "SessionStart",
    session_id: "provider-1",
    cwd: "/tmp/project"
  });
  assert.equal(codex.event, "session.started");
  assert.equal(
    codex.session_id,
    normalizeCodexHook({
      hook_event_name: "SessionEnd",
      session_id: "provider-1",
      cwd: "/tmp/project"
    }).session_id
  );
  assert.equal(codex.external_session_id, "provider-1");
  assert.equal(
    normalizeClaudeHook({
      hook_event_name: "StopFailure",
      session_id: "provider-1",
      cwd: "/tmp/project",
      error: "x"
    }).event,
    "run.failed"
  );
  assert.throws(() =>
    normalizeClaudeHook({
      hook_event_name: "PreToolUse",
      session_id: "x",
      cwd: "/tmp"
    })
  );
  assert.throws(() =>
    normalizeClaudeHook({
      hook_event_name: "SessionStart",
      session_id: "",
      cwd: "/tmp"
    })
  );
  assert.throws(() =>
    normalizeCodexHook({ hook_event_name: "SessionStart", session_id: "x" })
  );
  assert.match(deterministicSessionId("codex", "x"), /^[0-9a-f-]{36}$/);
});

test("hook stdin is bounded and malformed JSON is rejected", async () => {
  assert.deepEqual(
    await readBoundedStdin(
      chunks(Buffer.from('{"hook_event_name":"SessionEnd"}'))
    ),
    { hook_event_name: "SessionEnd" }
  );
  await assert.rejects(
    () => readBoundedStdin(chunks(Buffer.alloc(65 * 1024))),
    /64 KiB/
  );
  await assert.rejects(() => readBoundedStdin(chunks("not json")));
});

test("runHook posts normalized payload using the payload cwd mapping", async () => {
  const home = await mkdtemp(join("/tmp", "orchestrat-hook-"));
  const cwd = join(home, "project");
  await mkdir(join(home, ".orchestrat"), { recursive: true });
  await writeFile(
    join(home, ".orchestrat", "config.json"),
    JSON.stringify({
      version: 1,
      projects: {
        [cwd]: {
          projectId: "00000000-0000-4000-8000-000000000001",
          integrations: {
            codex: { agentId: "00000000-0000-4000-8000-000000000002" }
          }
        }
      }
    })
  );
  const calls: { url: string; init?: RequestInit }[] = [];
  try {
    const result = await runHook({
      integration: "codex",
      cwd: home,
      home,
      read: async () =>
        JSON.parse(
          await readFile(join(home, ".orchestrat", "config.json"), "utf8")
        ),
      credentials: {
        read: async (account) =>
          account === "agent:codex" ? `orch_agent_${"x".repeat(32)}` : undefined
      },
      payload: {
        hook_event_name: "SessionStart",
        session_id: "provider-id",
        cwd
      },
      api: "https://api.test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            event_id: 1,
            session: {
              id: "00000000-0000-4000-8000-000000000003",
              agent_id: "00000000-0000-4000-8000-000000000002",
              project_id: "00000000-0000-4000-8000-000000000001",
              runtime: "codex",
              integration: "codex",
              external_session_id: "provider-id",
              status: "active",
              started_at: "2026-08-22T00:00:00.000Z",
              ended_at: null,
              last_heartbeat_at: "2026-08-22T00:00:00.000Z"
            }
          })
        );
      }
    });
    assert.equal(result.event_id, 1);
    assert.equal(
      calls[0]!.url,
      "https://api.test/api/v1/agent/hooks/lifecycle"
    );
    assert.equal(
      (calls[0]!.init!.headers as Record<string, string>).authorization,
      `Bearer orch_agent_${"x".repeat(32)}`
    );
    const body = JSON.parse(String(calls[0]!.init!.body));
    assert.equal(body.event, "session.started");
    assert.equal(body.external_session_id, "provider-id");
    assert.equal(
      typeof (calls[0]!.init!.headers as Record<string, string>)[
        "idempotency-key"
      ],
      "string"
    );
    await runHook({
      integration: "codex",
      cwd: home,
      home,
      read: async () =>
        JSON.parse(
          await readFile(join(home, ".orchestrat", "config.json"), "utf8")
        ),
      credentials: {
        read: async (account) =>
          account === "agent:codex" ? `orch_agent_${"x".repeat(32)}` : undefined
      },
      payload: {
        hook_event_name: "SessionStart",
        session_id: "provider-id",
        cwd
      },
      api: "https://api.test",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({
            event_id: 1,
            session: {
              id: "00000000-0000-4000-8000-000000000003",
              agent_id: "00000000-0000-4000-8000-000000000002",
              project_id: "00000000-0000-4000-8000-000000000001",
              runtime: "codex",
              integration: "codex",
              external_session_id: "provider-id",
              status: "active",
              started_at: "2026-08-22T00:00:00.000Z",
              ended_at: null,
              last_heartbeat_at: "2026-08-22T00:00:00.000Z"
            }
          })
        );
      }
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.init!.body, calls[1]!.init!.body);
    assert.equal(
      (calls[0]!.init!.headers as Record<string, string>)["idempotency-key"],
      (calls[1]!.init!.headers as Record<string, string>)["idempotency-key"]
    );
    await assert.rejects(
      () =>
        runHook({
          integration: "codex",
          cwd: home,
          home,
          read: async () =>
            JSON.parse(
              await readFile(join(home, ".orchestrat", "config.json"), "utf8")
            ),
          credentials: { read: async () => `orch_agent_${"x".repeat(32)}` },
          payload: {
            hook_event_name: "SessionStart",
            session_id: "raw-secret-payload",
            cwd
          },
          api: "https://api.test",
          fetch: async () => {
            throw new Error(
              `backend failed raw-secret-payload orch_agent_${"x".repeat(32)}`
            );
          }
        }),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes("raw-secret-payload") &&
        !error.message.includes("orch_agent_")
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runHook dispatches Cursor and Antigravity hooks using workspace cwd fallbacks", async () => {
  const home = await mkdtemp(join("/tmp", "orchestrat-hook-runtime-"));
  const cwd = join(home, "project");
  const config = {
    version: 1 as const,
    projects: {
      [cwd]: {
        projectId: "00000000-0000-4000-8000-000000000001",
        integrations: {
          cursor: { agentId: "00000000-0000-4000-8000-000000000002" },
          antigravity: { agentId: "00000000-0000-4000-8000-000000000003" }
        }
      }
    }
  };
  const payloads: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        event_id: 1,
        session: {
          id: "00000000-0000-4000-8000-000000000004",
          agent_id: "00000000-0000-4000-8000-000000000002",
          project_id: "00000000-0000-4000-8000-000000000001",
          runtime: "cursor",
          integration: "cursor",
          external_session_id: "provider-id",
          status: "active",
          started_at: "2026-08-22T00:00:00.000Z",
          ended_at: null,
          last_heartbeat_at: "2026-08-22T00:00:00.000Z"
        }
      })
    );
  };
  const common = {
    cwd: home,
    home,
    read: async () => config,
    credentials: { read: async () => "orch_agent_token" },
    api: "https://api.test",
    fetch
  };
  try {
    await runHook({
      ...common,
      integration: "cursor",
      payload: {
        hook_event_name: "sessionStart",
        conversation_id: "cursor-1",
        workspace_roots: [cwd]
      }
    });
    await runHook({
      ...common,
      integration: "antigravity",
      event: "PreInvocation",
      payload: { conversationId: "agy-1", workspacePaths: [cwd] }
    });
    assert.equal((payloads[0] as { event: string }).event, "session.started");
    assert.equal((payloads[1] as { event: string }).event, "session.started");
    await assert.rejects(() =>
      runHook({
        ...common,
        integration: "opencode",
        payload: {}
      })
    , /OpenCode does not support hooks/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
