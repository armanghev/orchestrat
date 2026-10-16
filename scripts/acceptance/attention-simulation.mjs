#!/usr/bin/env node
// Local end-to-end simulation of agent attention and handoffs.
//
//   source <test-env.sh>   # sets ORCHESTRAT_TEST_POSTGRES_URL (admin DB)
//   node scripts/acceptance/attention-simulation.mjs
//
// Creates a disposable database, applies every migration, runs the built API
// (apps/api/dist) in a child process on 127.0.0.1:<random>, drives two agents
// through the built SDK, MCP bridge and CLI modules, prints one PASS/FAIL line
// per step and always drops the database. Needs a prior `pnpm build`.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream, realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const load = (relative) => import(pathToFileURL(join(root, relative)).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A timer that never holds the process open (for race/timeout guards).
const idle = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

if (process.argv[2] === "--api-child") await runApiChild();
else await main();

// ---------------------------------------------------------------------------
// API child: the real Fastify app with a stub human auth (as the Postgres
// integration tests use). Its pino logs go to a file, not the report.
async function runApiChild() {
  const { buildApp } = await load("apps/api/dist/app.js");
  const { createDatabase } = await load("packages/db/dist/index.js");
  const { db, pool } = createDatabase({
    connectionString: process.env.SIM_DATABASE_URL,
    max: 8
  });
  const app = buildApp({
    allowedOrigins: [],
    db,
    auth: {
      async authenticate(request) {
        const token = [...request.headers]
          .find(([key]) => key.toLowerCase() === "authorization")?.[1]
          ?.replace(/^Bearer\s+/, "");
        if (token !== "sim-human") return null;
        return {
          authSubject: "attention-sim-human",
          avatarUrl: null,
          email: "sim-human@example.com",
          name: "Sim Human",
          provider: "supabase",
          username: "simhuman"
        };
      }
    }
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  process.send({ port: app.server.address().port });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await app.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("disconnect", shutdown);
}

// ---------------------------------------------------------------------------
async function main() {
  const started = Date.now();
  const adminUrl = process.env.ORCHESTRAT_TEST_POSTGRES_URL;
  if (!adminUrl) {
    console.error(
      "FAIL setup: ORCHESTRAT_TEST_POSTGRES_URL is not set (source the test env first)"
    );
    process.exit(1);
  }
  const host = new URL(adminUrl).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    console.error("FAIL setup: refusing a non-local Postgres URL");
    process.exit(1);
  }

  const { createDatabase } = await load("packages/db/dist/index.js");
  const { AgentApiClient } = await load("packages/sdk/dist/index.js");
  const { McpBridge } = await load("packages/mcp/dist/index.js");
  const mcpServerDir = realpathSync(
    join(root, "packages/mcp/node_modules/@modelcontextprotocol/server")
  );
  const { InMemoryTransport, LATEST_PROTOCOL_VERSION } = await import(
    pathToFileURL(join(mcpServerDir, "dist/index.mjs")).href
  );
  const { decideStop, renderStopDecision } = await load(
    "apps/cli/dist/stop-hooks.js"
  );
  const { runWakerCommand, WAKE_PROMPT } = await load("apps/cli/dist/waker.js");
  const { MemoryCredentialReader, agentAccount } = await load(
    "apps/cli/dist/keychain.js"
  );
  const { apiOrigin } = await load("apps/cli/dist/config.js");

  const results = [];
  const cleanups = [];
  const dbName = `orchestrat_sim_${randomUUID().replaceAll("-", "")}`;
  const apiLog = join(tmpdir(), `${dbName}-api.log`);
  const admin = createDatabase({ connectionString: adminUrl, max: 1 });
  let pool;
  let child;

  const record = (name, ok, detail, ms) => {
    results.push(ok);
    console.log(
      `${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""} (${ms} ms)`
    );
  };
  const step = async (name, run) => {
    const t0 = Date.now();
    try {
      const detail = await run();
      record(name, true, detail, Date.now() - t0);
      return true;
    } catch (error) {
      record(
        name,
        false,
        error instanceof Error ? error.message : String(error),
        Date.now() - t0
      );
      return false;
    }
  };

  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  process.once("SIGINT", onSignal);

  await admin.pool.query(`CREATE DATABASE "${dbName}"`);
  try {
    const dbUrl = new URL(adminUrl);
    dbUrl.pathname = `/${dbName}`;
    ({ pool } = createDatabase({
      connectionString: dbUrl.toString(),
      max: 2
    }));

    // Shared world, filled in by setup.
    const w = {};

    const setupOk = await step("setup", async () => {
      const migrations = join(root, "packages/db/drizzle");
      const files = (await readdir(migrations))
        .filter((file) => file.endsWith(".sql"))
        .sort();
      for (const file of files)
        await pool.query(await readFile(join(migrations, file), "utf8"));

      const log = createWriteStream(apiLog);
      child = fork(fileURLToPath(import.meta.url), ["--api-child"], {
        env: { ...process.env, SIM_DATABASE_URL: dbUrl.toString() },
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      });
      child.stdout.pipe(log);
      child.stderr.pipe(log);
      const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("API child did not start in 20 s")),
          20_000
        );
        child.once("message", (message) => {
          clearTimeout(timer);
          resolve(message.port);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`API child exited (${code}); see ${apiLog}`));
        });
      });
      w.api = `http://127.0.0.1:${port}`;

      let keys = 0;
      w.human = async (method, path, body) => {
        const response = await fetch(`${w.api}/api/v1${path}`, {
          method,
          headers: {
            authorization: "Bearer sim-human",
            "idempotency-key": `sim-human-${++keys}`,
            ...(body ? { "content-type": "application/json" } : {})
          },
          ...(body ? { body: JSON.stringify(body) } : {})
        });
        const text = await response.text();
        if (!response.ok)
          throw new Error(`${method} ${path} -> ${response.status} ${text}`);
        return text ? JSON.parse(text) : undefined;
      };
      const org = await w.human("POST", "/organizations", {
        name: "Attention simulation"
      });
      w.project = await w.human("POST", `/organizations/${org.id}/projects`, {
        name: "Attention sim"
      });
      const pid = w.project.id;
      const createAgent = async (name) => {
        const agent = await w.human("POST", `/projects/${pid}/agents`, {
          name
        });
        const { token } = await w.human(
          "POST",
          `/projects/${pid}/agents/${agent.id}/credentials`
        );
        return {
          id: agent.id,
          name,
          token,
          sdk: new AgentApiClient({ baseUrl: w.api, token })
        };
      };
      w.A = await createAgent("sim-agent-a");
      w.B = await createAgent("sim-agent-b");
      w.C = await createAgent("sim-agent-c-offline");
      const createTask = (title) =>
        w.human("POST", `/projects/${pid}/tasks`, { title, status: "ready" });
      w.T = await createTask("Guarded completion task");
      w.U = await createTask("Blocked then handed-off task");
      w.V = await createTask("Spare task");

      w.bridgeA = await openBridge(w.A.sdk, "claude-code");
      w.bridgeB = await openBridge(w.B.sdk, "codex");
      return `db ${dbName}, ${files.length} migrations, API ${w.api}, agents A/B/C, tasks ${w.T.key}/${w.U.key}/${w.V.key}`;
    });

    async function openBridge(client, integration) {
      const bridge = new McpBridge({
        client,
        integration,
        heartbeatMs: 15_000,
        inboxTimeoutMs: 2_000
      });
      await bridge.start();
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await bridge.server.connect(serverSide);
      await clientSide.start();
      const pending = new Map();
      let nextId = 1;
      clientSide.onmessage = (message) => {
        if ("id" in message && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      };
      const request = (method, params) =>
        new Promise((resolve) => {
          const id = nextId++;
          pending.set(id, resolve);
          void clientSide.send({ jsonrpc: "2.0", id, method, params });
        });
      const init = await request("initialize", {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "attention-simulation", version: "1" }
      });
      if (init.error) throw new Error(`initialize: ${init.error.message}`);
      await clientSide.send({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });
      const parse = (text) => {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      };
      const tool = async (name, args = {}) => {
        const response = await request("tools/call", {
          name,
          arguments: args
        });
        if (response.error)
          throw new Error(`${name}: ${JSON.stringify(response.error)}`);
        const blocks = response.result.content.map((item) => parse(item.text));
        return {
          isError: response.result.isError === true,
          body: blocks[0],
          notices: blocks
            .slice(1)
            .map((block) => block?.notice)
            .filter(Boolean)
        };
      };
      const ok = async (name, args) => {
        const result = await tool(name, args);
        if (result.isError)
          throw new Error(`${name} failed: ${JSON.stringify(result.body)}`);
        return result;
      };
      cleanups.push(async () => {
        await bridge.stop();
      });
      return { bridge, tool, ok };
    }

    // Drains any events after `cursor` so the next wait starts quiet.
    const freshCursor = async (cursor) => {
      for (let round = 0; round < 10; round += 1) {
        const result = await w.bridgeA.ok("wait_for_update", {
          ...(cursor ? { cursor } : {}),
          max_wait_seconds: 0
        });
        cursor = result.body.cursor;
        if (result.body.status === "no_updates") return cursor;
      }
      return cursor;
    };

    if (!setupOk) throw new Error("setup failed");
    const { A, B, C, T, U } = w;

    await step("1 completion guard", async () => {
      await w.bridgeA.ok("claim_task", { task_id: T.id });
      const commentText = "B here: please also update the changelog.";
      const comment = await w.bridgeB.ok("add_task_comment", {
        task_id: T.id,
        body_markdown: commentText,
        idempotency_key: "sim-b-comment-t-1"
      });
      const refused = await w.bridgeA.tool("complete_task", {
        task_id: T.id
      });
      assert.equal(refused.isError, true, "complete_task should be refused");
      const error = refused.body.error;
      assert.equal(error.code, "TASK_COMMENTS_UNREAD", JSON.stringify(error));
      const unread = error.details?.unread ?? [];
      assert.ok(
        unread.some(
          (item) =>
            item.author.id === B.id && item.excerpt.includes("changelog")
        ),
        `B's comment missing from details: ${JSON.stringify(error.details)}`
      );
      const latest = error.details.latest_sequence;
      assert.equal(latest, comment.body.sequence);

      const next = await w.bridgeA.ok("get_task", { task_id: T.id });
      const notice = next.notices.find((item) => item.type === "attention");
      assert.ok(
        notice,
        `no attention notice on next tool call: ${JSON.stringify(next.notices)}`
      );
      const noticed = notice.tasks.find((item) => item.task_id === T.id);
      assert.ok(
        noticed && noticed.unread_comments >= 1,
        JSON.stringify(notice)
      );
      assert.equal(noticed.claimed_by_you, true);

      await w.bridgeA.ok("complete_task", {
        task_id: T.id,
        acknowledged_through: latest
      });
      const task = await A.sdk.getTask(T.id);
      assert.equal(task.status, "done");
      return `409 TASK_COMMENTS_UNREAD (latest_sequence ${latest}, author ${unread[0].author.name}); notice lists ${noticed.key} unread=${noticed.unread_comments}; retry with acknowledged_through=${latest} -> ${task.status}`;
    });

    await step("2 blocked + handoff + wait", async () => {
      await w.bridgeA.ok("claim_task", { task_id: U.id });
      const blocked = await w.bridgeA.ok("set_task_status", {
        task_id: U.id,
        status: "blocked",
        reason: "Need B's decision on the API shape",
        blocked_on: { type: "agent", id: B.id }
      });
      assert.equal(blocked.body.task.status, "blocked");
      const blockId = blocked.body.block.id;
      const cursor = await freshCursor();
      const waiting = w.bridgeA.ok("wait_for_update", {
        cursor,
        max_wait_seconds: 20
      });
      await sleep(500);
      const sentAt = Date.now();
      const handoffBody = "Decision made: use the v2 endpoints. U is yours.";
      const handoff = await w.bridgeB.ok("handoff", {
        to: { type: "agent", id: A.id },
        message: handoffBody,
        task_id: U.id,
        idempotency_key: "sim-handoff-u"
      });
      const woke = await waiting;
      const latency = Date.now() - sentAt;
      assert.equal(woke.body.status, "updates", JSON.stringify(woke.body));
      const event = woke.body.events.find(
        (item) =>
          item.kind === "handoff" && item.handoff_id === handoff.body.handoff.id
      );
      assert.ok(
        event,
        `no handoff event: ${JSON.stringify(woke.body.events.map((item) => item.kind))}`
      );
      assert.equal(event.task?.id, U.id);
      assert.ok(latency < 2000, `wait returned after ${latency} ms`);

      const task = await A.sdk.getTask(U.id);
      assert.equal(task.status, "in_progress");
      const block = (
        await pool.query(
          "SELECT resolved_at, resolution FROM task_blocks WHERE id=$1",
          [blockId]
        )
      ).rows[0];
      assert.ok(block?.resolved_at, "block not resolved");

      // A reads and acknowledges, leaving a clean slate for later steps.
      const attention = await w.bridgeA.ok("get_attention");
      const items = [
        ...attention.body.handoffs.map((item) => ({
          type: "handoff",
          handoff_id: item.handoff_id
        })),
        ...attention.body.blockers_resolved.map((item) => ({
          type: "blocker",
          block_id: item.block_id
        }))
      ];
      if (items.length) await w.bridgeA.ok("acknowledge_attention", { items });
      await w.bridgeA.ok("acknowledge_messages", {
        chat_id: handoff.body.handoff.chat_id,
        through_message_id: handoff.body.handoff.message_id
      });
      await w.bridgeA.ok("complete_task", { task_id: U.id });
      w.cursor = woke.body.cursor;
      return `wait woke ${latency} ms after handoff (hop ${handoff.body.handoff.hop}) with [${woke.body.events.map((item) => item.kind).join(", ")}]; ${task.key} ${task.status}, block resolution=${block.resolution}`;
    });

    await step("3 no updates, then watched comment", async () => {
      const cursor = await freshCursor(w.cursor);
      const t0 = Date.now();
      const quiet = await w.bridgeA.ok("wait_for_update", {
        cursor,
        max_wait_seconds: 5
      });
      const waited = Date.now() - t0;
      assert.equal(quiet.body.status, "no_updates", JSON.stringify(quiet.body));
      assert.match(quiet.body.cursor, /^[0-9]+$/);
      assert.ok(waited >= 3000 && waited <= 7000, `waited ${waited} ms`);

      const comment = await w.bridgeB.ok("add_task_comment", {
        task_id: T.id,
        body_markdown: "Follow-up after merge: changelog looks good.",
        idempotency_key: "sim-b-comment-t-2"
      });
      const t1 = Date.now();
      const next = await w.bridgeA.ok("wait_for_update", {
        cursor: quiet.body.cursor,
        max_wait_seconds: 10
      });
      const latency = Date.now() - t1;
      assert.equal(next.body.status, "updates", JSON.stringify(next.body));
      const event = next.body.events.find(
        (item) => item.kind === "task_comment" && item.task?.id === T.id
      );
      assert.ok(event, JSON.stringify(next.body.events));
      assert.equal(event.comment_sequence, comment.body.sequence);
      await w.bridgeA.ok("acknowledge_attention", {
        items: [
          {
            type: "task_comments",
            task_id: T.id,
            through_sequence: comment.body.sequence
          }
        ]
      });
      return `no_updates after ${waited} ms (waited_seconds=${quiet.body.waited_seconds}, cursor ${quiet.body.cursor}); next wait returned task_comment seq ${event.comment_sequence} in ${latency} ms`;
    });

    await step("4 stop hook", async () => {
      const home = await realpath(
        await mkdtemp(join(tmpdir(), "orch-sim-stop-"))
      );
      cleanups.push(() => rm(home, { recursive: true, force: true }));
      const cwd = join(home, "project");
      await mkdir(join(home, ".orchestrat"), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await writeFile(
        join(home, ".orchestrat", "config.json"),
        JSON.stringify({
          version: 1,
          projects: {
            [cwd]: {
              projectId: w.project.id,
              apiUrl: w.api,
              integrations: { "claude-code": { agentId: A.id } }
            }
          },
          attention: { continue_on_stop: ["claude-code"] }
        })
      );
      const credentials = new MemoryCredentialReader(
        new Map([
          [agentAccount(w.project.id, "claude-code", apiOrigin(w.api)), A.token]
        ])
      );
      const body = "Please review the migration plan in docs/plan.md";
      await w.bridgeB.ok("handoff", {
        to: { type: "agent", id: A.id },
        message: body,
        idempotency_key: "sim-handoff-stop"
      });
      const payload = (active) => ({
        session_id: "sim-claude-session-1",
        transcript_path: join(home, "transcript.jsonl"),
        cwd,
        permission_mode: "default",
        hook_event_name: "Stop",
        stop_hook_active: active
      });
      const input = (active) => ({
        integration: "claude-code",
        payload: payload(active),
        cwd,
        home,
        api: w.api,
        credentials
      });
      const first = await decideStop(input(false));
      const firstOut = renderStopDecision("claude-code", first);
      assert.equal(first.continue, true, JSON.stringify(first));
      assert.equal(firstOut.exitCode, 2);
      assert.match(firstOut.stderr, /1 handoff from sim-agent-b/);
      assert.match(firstOut.stderr, /get_attention/);
      assert.ok(!firstOut.stderr.includes("migration plan"), "body leaked");

      const second = await decideStop(input(true));
      const secondOut = renderStopDecision("claude-code", second);
      assert.equal(second.continue, false, JSON.stringify(second));
      assert.equal(secondOut.exitCode, 0);
      return `first Stop -> exit ${firstOut.exitCode} "${firstOut.stderr.trim().slice(0, 60)}..."; stop_hook_active Stop -> exit ${secondOut.exitCode} (${second.why})`;
    });

    await step("5 waker + handoff chain limit", async () => {
      const home = await realpath(
        await mkdtemp(join(tmpdir(), "orch-sim-waker-"))
      );
      cleanups.push(() => rm(home, { recursive: true, force: true }));
      const cwd = join(home, "project");
      await mkdir(join(home, ".orchestrat"), { recursive: true });
      await mkdir(cwd, { recursive: true });
      const configFile = join(home, ".orchestrat", "config.json");
      await writeFile(
        configFile,
        JSON.stringify({
          version: 1,
          projects: {
            [cwd]: {
              projectId: w.project.id,
              apiUrl: w.api,
              integrations: { "claude-code": { agentId: C.id } }
            }
          },
          waker: {
            enabled: true,
            agents: [
              {
                project_id: w.project.id,
                integration: "claude-code",
                cwd,
                wake_on: ["handoff"]
              }
            ]
          }
        })
      );
      const credentials = new MemoryCredentialReader(
        new Map([
          [agentAccount(w.project.id, "claude-code", apiOrigin(w.api)), C.token]
        ])
      );
      const spawns = [];
      const clients = [];
      const fakeSpawn = (command, args, options) => {
        spawns.push({ command, args: [...args], options });
        const proc = new EventEmitter();
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.kill = () => true;
        proc.stdout.on("end", () => setImmediate(() => proc.emit("close", 0)));
        setImmediate(() => {
          proc.stdout.end(
            `${JSON.stringify({ type: "result", session_id: "sim-waker-session-1", result: "handled" })}\n`
          );
          proc.stderr.end();
        });
        return proc;
      };
      const output = [];
      const abort = new AbortController();
      const guard = setTimeout(() => abort.abort(), 20_000);
      const run = runWakerCommand(
        ["run", "--once"],
        { home, cwd, api: w.api, credentials },
        {
          spawn: fakeSpawn,
          createClient: (options) => {
            clients.push(options.baseUrl);
            return new AgentApiClient(options);
          },
          isTTY: false,
          stdout: (text) => output.push(text),
          stderr: (text) => output.push(text),
          signal: abort.signal
        }
      );
      await sleep(1000);
      const secret = "SECRET-HANDOFF-BODY rm -rf / $(whoami)";
      const handoff = await w.bridgeB.ok("handoff", {
        to: { type: "agent", id: C.id },
        message: secret,
        idempotency_key: "sim-handoff-offline"
      });
      const code = await run;
      clearTimeout(guard);
      assert.equal(code, 0, output.join(""));
      assert.deepEqual(clients, [w.api]);
      assert.equal(spawns.length, 1, `spawns: ${JSON.stringify(spawns)}`);
      const [spawned] = spawns;
      assert.equal(spawned.command, "claude");
      assert.deepEqual(spawned.args, [
        "-p",
        WAKE_PROMPT,
        "--output-format",
        "json"
      ]);
      assert.equal(spawned.options.shell, false);
      assert.equal(spawned.options.cwd, cwd);
      const argvText = [spawned.command, ...spawned.args].join(" ");
      assert.ok(!argvText.includes("SECRET"), "message text reached argv");
      assert.ok(!argvText.includes(handoff.body.handoff.id));
      const saved = JSON.parse(await readFile(configFile, "utf8"));
      assert.deepEqual(saved.waker.agents[0].owned_sessions, [
        "sim-waker-session-1"
      ]);
      // The waker records the wake with C's own credential before spawning.
      const wakes = (
        await pool.query(
          "SELECT payload FROM project_events WHERE project_id=$1 AND type='run.woken'",
          [w.project.id]
        )
      ).rows;
      assert.equal(wakes.length, 1, JSON.stringify(wakes));
      assert.equal(wakes[0].payload.handoff_id, handoff.body.handoff.id);
      assert.equal(wakes[0].payload.integration, "claude-code");

      // Ping chain A->B->A->B... until the server refuses.
      const hops = [];
      let failure;
      for (let index = 0; index < 10; index += 1) {
        const [from, to] = index % 2 === 0 ? [A, B] : [B, A];
        try {
          const result = await from.sdk.attention.handoff(
            {
              to: { type: "agent", id: to.id },
              body_markdown: `ping ${index}`
            },
            `sim-ping-${index}`
          );
          hops.push(result.handoff.hop);
        } catch (error) {
          failure = error;
          break;
        }
      }
      assert.ok(failure, `no limit after hops ${hops.join(",")}`);
      assert.equal(failure.status, 429, failure.message);
      assert.equal(failure.code, "HANDOFF_CHAIN_LIMIT", failure.message);
      assert.equal(failure.details.max_hop, 4);
      assert.ok(failure.details.hop > 4);
      assert.ok(hops.every((hop) => hop <= 4));
      hops.forEach((hop, index) => {
        if (index) assert.equal(hop, hops[index - 1] + 1);
      });
      assert.equal(failure.details.hop, hops.at(-1) + 1);
      return `1 spawn: ${JSON.stringify([spawned.command, ...spawned.args])} (shell=false, 1 run.woken for the handoff, owned session saved); chain hops ${hops.join("->")} then 429 HANDOFF_CHAIN_LIMIT at hop ${failure.details.hop}`;
    });
  } catch (error) {
    if (!results.length || results.every(Boolean))
      record("run", false, error.message, 0);
  } finally {
    for (const cleanup of cleanups.reverse())
      await Promise.resolve()
        .then(cleanup)
        .catch(() => undefined);
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, idle(5000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await pool?.end().catch(() => undefined);
    let dropped = false;
    try {
      await admin.pool.query(
        `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`
      );
      dropped = true;
    } catch {
      try {
        await admin.pool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        dropped = true;
      } catch (error) {
        console.error(`WARN could not drop ${dbName}: ${error.message}`);
      }
    }
    await admin.pool.end().catch(() => undefined);
    process.off("SIGINT", onSignal);
    const failed = results.filter((ok) => !ok).length;
    if (!failed && !interrupted) await rm(apiLog, { force: true });
    console.log(
      `${failed || interrupted ? "FAIL" : "PASS"} total: ${results.length - failed}/${results.length} passed in ${((Date.now() - started) / 1000).toFixed(1)} s; database ${dbName} ${dropped ? "dropped" : "NOT dropped"}${failed ? `; API log ${apiLog}` : ""}`
    );
    process.exitCode = failed || interrupted || !dropped ? 1 : 0;
  }
}
