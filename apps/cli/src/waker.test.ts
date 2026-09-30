import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import {
  DEFAULT_WAKER_LIMITS,
  ENABLE_CONFIRMATION,
  harnessArgv,
  HARNESS_COMMANDS,
  nextWakeAt,
  parseSessionId,
  runWakerCommand,
  WAKE_PROMPT,
  wakerLogPath,
  type WakerDeps
} from "./waker.js";

const PROJECT = randomUUID();
const AGENT = randomUUID();
const SECRET = "SECRET HANDOFF BODY rm -rf /";
const T0 = Date.parse("2026-09-27T10:00:00.000Z");

type SpawnCall = { command: string; args: string[]; options: SpawnOptions };

async function fixture(waker?: unknown) {
  const home = await mkdtemp(join(tmpdir(), "orchestrat-waker-"));
  const cwd = join(home, "project");
  await mkdir(cwd);
  const real = await realpath(cwd);
  await mkdir(join(home, ".orchestrat"), { recursive: true });
  await writeFile(
    join(home, ".orchestrat", "config.json"),
    JSON.stringify({
      version: 1,
      projects: {
        [real]: {
          projectId: PROJECT,
          integrations: { codex: { agentId: AGENT } }
        }
      },
      ...(waker === undefined ? {} : { waker })
    })
  );
  return {
    home,
    cwd: real,
    ctx: {
      home,
      cwd: real,
      api: "http://127.0.0.1:9",
      credentials: { read: async () => "agent-token" }
    },
    cleanup: () => rm(home, { recursive: true, force: true })
  };
}

const enabled = (cwd: string, owned: string[] = []) => ({
  enabled: true,
  agents: [
    {
      project_id: PROJECT,
      integration: "codex",
      cwd,
      wake_on: ["handoff"],
      resume_foreign_sessions: false,
      owned_sessions: owned
    }
  ]
});

const summary = {
  cursor: "0",
  branch_id: null,
  unread_chats: [],
  tasks: [],
  handoffs: [],
  blockers_resolved: [],
  truncated: false
};

const handoffEvent = (eventId: number, handoffId = randomUUID()) => ({
  kind: "handoff",
  event_id: eventId,
  occurred_at: new Date(T0).toISOString(),
  actor: { type: "agent", id: randomUUID(), name: "claude" },
  task: null,
  chat_id: randomUUID(),
  message_id: randomUUID(),
  handoff_id: handoffId,
  excerpt: SECRET,
  branch_id: null
});

// Routes the SDK's real requests: wait responses are served in order and a
// drained queue answers "timeout".
function fakeApi(input: {
  waits: unknown[];
  presence?: "online" | "offline";
  wake?: { status: number; code?: string };
}) {
  const calls: { path: string; body?: unknown }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname.replace("/api/v1/agent", "");
    calls.push({
      path: `${path}${parsed.search}`,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
      });
    if (path === "/attention/wait") {
      const next = input.waits.shift();
      return json(
        200,
        next ?? {
          status: "timeout",
          events: [],
          cursor: "999",
          attention: summary
        }
      );
    }
    if (path === "/presence")
      return json(200, {
        agents: [
          {
            agent_id: AGENT,
            project_id: PROJECT,
            session_id: null,
            status: input.presence ?? "offline",
            last_heartbeat_at: null,
            current_task_id: null
          }
        ]
      });
    if (path === "/wakes") {
      const wake = input.wake ?? { status: 201 };
      return wake.status < 300
        ? json(wake.status, { wake_event_id: 1 })
        : json(wake.status, {
            error: {
              code: wake.code ?? "WAKE_LIMIT",
              message: "limit",
              details: {},
              request_id: "req"
            }
          });
    }
    return json(404, {
      error: {
        code: "NOT_FOUND",
        message: "nope",
        details: {},
        request_id: "r"
      }
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

// A fake harness binary: records argv and prints the given JSON output.
function fakeSpawn(output: string, code = 0) {
  const calls: SpawnCall[] = [];
  const spawn = (
    command: string,
    args: readonly string[],
    options: SpawnOptions
  ) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(output);
      child.stderr.end();
      child.stdout.on("end", () => child.emit("close", code));
      child.stdout.resume();
    });
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

function deps(overrides: Partial<WakerDeps>) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: {
      stdout: (text: string) => void out.push(text),
      stderr: (text: string) => void err.push(text),
      now: () => T0,
      sleep: async () => {},
      isTTY: false,
      signal: new AbortController().signal,
      pid: 424242,
      ...overrides
    } satisfies Partial<WakerDeps>
  };
}

const readJson = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, any>;

test("one handoff spawns exactly one new headless session with a fixed prompt", async () => {
  const env = await fixture();
  await writeFile(
    join(env.home, ".orchestrat", "config.json"),
    JSON.stringify({
      ...(await readJson(join(env.home, ".orchestrat", "config.json"))),
      waker: enabled(env.cwd)
    })
  );
  try {
    const handoffId = randomUUID();
    const api = fakeApi({
      waits: [
        {
          status: "updates",
          events: [handoffEvent(7, handoffId)],
          cursor: "7",
          attention: summary
        }
      ]
    });
    const harness = fakeSpawn(
      `${JSON.stringify({ type: "thread.started", thread_id: "thread-1" })}\n`
    );
    const run = deps({ fetch: api.fetch, spawn: harness.spawn });
    assert.equal(
      await runWakerCommand(["run", "--once"], env.ctx, run.deps),
      0
    );
    assert.equal(harness.calls.length, 1);
    const [call] = harness.calls;
    assert.deepEqual(
      [call!.command, ...call!.args],
      ["codex", "exec", "--json", WAKE_PROMPT]
    );
    assert.equal(call!.options.cwd, env.cwd);
    assert.equal(call!.options.shell, false);
    assert.ok(
      !call!.args.some(
        (arg) => arg.includes("SECRET") || arg.includes("rm -rf")
      )
    );
    assert.ok(!call!.args.some((arg) => arg.startsWith("--dangerously")));
    const wakes = api.calls.filter((entry) => entry.path === "/wakes");
    assert.deepEqual(
      wakes.map((entry) => entry.body),
      [{ integration: "codex", handoff_id: handoffId }]
    );
    const wait = api.calls.find((entry) =>
      entry.path.startsWith("/attention/wait")
    )!;
    assert.match(wait.path, /directed_only=true/);
    assert.match(wait.path, /kinds=handoff/);
    const config = await readJson(join(env.home, ".orchestrat", "config.json"));
    assert.deepEqual(config.waker.agents[0].owned_sessions, ["thread-1"]);
    // The rest of the config survives the waker's write.
    assert.equal(config.projects[env.cwd].projectId, PROJECT);
    const log = await readFile(wakerLogPath(env.home), "utf8");
    assert.ok(!log.includes("SECRET") && !log.includes("agent-token"));
  } finally {
    await env.cleanup();
  }
});

test("a second handoff within five minutes is deferred, then resumes the owned session", async () => {
  const env = await fixture();
  await writeFile(
    join(env.home, ".orchestrat", "config.json"),
    JSON.stringify({
      ...(await readJson(join(env.home, ".orchestrat", "config.json"))),
      waker: enabled(env.cwd)
    })
  );
  try {
    const first = fakeApi({
      waits: [
        {
          status: "updates",
          events: [handoffEvent(1)],
          cursor: "1",
          attention: summary
        }
      ]
    });
    const firstHarness = fakeSpawn(
      JSON.stringify({ thread_id: "thread-owned" })
    );
    assert.equal(
      await runWakerCommand(
        ["run", "--once"],
        env.ctx,
        deps({ fetch: first.fetch, spawn: firstHarness.spawn }).deps
      ),
      0
    );
    assert.equal(firstHarness.calls.length, 1);

    const second = fakeApi({
      waits: [
        {
          status: "updates",
          events: [handoffEvent(2)],
          cursor: "2",
          attention: summary
        }
      ]
    });
    const secondHarness = fakeSpawn("{}");
    const deferred = deps({
      fetch: second.fetch,
      spawn: secondHarness.spawn,
      now: () => T0 + 60_000
    });
    assert.equal(
      await runWakerCommand(["run", "--once"], env.ctx, deferred.deps),
      0
    );
    assert.equal(secondHarness.calls.length, 0);
    assert.equal(
      second.calls.filter((entry) => entry.path === "/wakes").length,
      0
    );
    assert.match(second.calls[0]!.path, /after=1/);
    assert.match(deferred.out.join(""), /deferred until/);

    // Past the 5 min spacing the deferred handoff wakes the owned session.
    const third = fakeApi({ waits: [] });
    const thirdHarness = fakeSpawn(
      JSON.stringify({ thread_id: "thread-owned" })
    );
    assert.equal(
      await runWakerCommand(
        ["run", "--once"],
        env.ctx,
        deps({
          fetch: third.fetch,
          spawn: thirdHarness.spawn,
          now: () => T0 + 6 * 60_000
        }).deps
      ),
      0
    );
    assert.equal(thirdHarness.calls.length, 1);
    assert.deepEqual(
      [thirdHarness.calls[0]!.command, ...thirdHarness.calls[0]!.args],
      ["codex", "exec", "resume", "thread-owned", "--json", WAKE_PROMPT]
    );
    assert.equal(
      third.calls.filter((entry) => entry.path === "/wakes").length,
      1
    );
  } finally {
    await env.cleanup();
  }
});

test("a 429 from recordWake skips the wake without spawning", async () => {
  const env = await fixture();
  await writeFile(
    join(env.home, ".orchestrat", "config.json"),
    JSON.stringify({
      ...(await readJson(join(env.home, ".orchestrat", "config.json"))),
      waker: enabled(env.cwd)
    })
  );
  try {
    const api = fakeApi({
      waits: [
        {
          status: "updates",
          events: [handoffEvent(3)],
          cursor: "3",
          attention: summary
        }
      ],
      wake: { status: 429, code: "HANDOFF_CHAIN_LIMIT" }
    });
    const harness = fakeSpawn("{}");
    assert.equal(
      await runWakerCommand(
        ["run", "--once"],
        env.ctx,
        deps({ fetch: api.fetch, spawn: harness.spawn }).deps
      ),
      0
    );
    assert.equal(harness.calls.length, 0);
    assert.equal(
      api.calls.filter((entry) => entry.path === "/wakes").length,
      1
    );
    assert.match(
      await readFile(wakerLogPath(env.home), "utf8"),
      /budget: server refused wake \(HANDOFF_CHAIN_LIMIT\)/
    );
  } finally {
    await env.cleanup();
  }
});

test("an agent with an online session is not woken", async () => {
  const env = await fixture();
  await writeFile(
    join(env.home, ".orchestrat", "config.json"),
    JSON.stringify({
      ...(await readJson(join(env.home, ".orchestrat", "config.json"))),
      waker: enabled(env.cwd)
    })
  );
  try {
    const api = fakeApi({
      waits: [
        {
          status: "updates",
          events: [handoffEvent(4)],
          cursor: "4",
          attention: summary
        }
      ],
      presence: "online"
    });
    const harness = fakeSpawn("{}");
    assert.equal(
      await runWakerCommand(
        ["run", "--once"],
        env.ctx,
        deps({ fetch: api.fetch, spawn: harness.spawn }).deps
      ),
      0
    );
    assert.equal(harness.calls.length, 0);
    assert.equal(
      api.calls.filter((entry) => entry.path === "/wakes").length,
      0
    );
  } finally {
    await env.cleanup();
  }
});

test("a pending level snapshot on the first wait wakes for its handoffs", async () => {
  const env = await fixture();
  await writeFile(
    join(env.home, ".orchestrat", "config.json"),
    JSON.stringify({
      ...(await readJson(join(env.home, ".orchestrat", "config.json"))),
      waker: enabled(env.cwd)
    })
  );
  try {
    const handoffId = randomUUID();
    const api = fakeApi({
      waits: [
        {
          status: "pending",
          events: [],
          cursor: "12",
          attention: {
            ...summary,
            handoffs: [
              {
                handoff_id: handoffId,
                from: { type: "human", id: randomUUID(), name: "Arman" },
                chat_id: randomUUID(),
                message_id: randomUUID(),
                sequence: 1,
                task: null,
                excerpt: SECRET,
                created_at: new Date(T0).toISOString(),
                hop: 1
              }
            ]
          }
        }
      ]
    });
    const harness = fakeSpawn("{}");
    assert.equal(
      await runWakerCommand(
        ["run", "--once"],
        env.ctx,
        deps({ fetch: api.fetch, spawn: harness.spawn }).deps
      ),
      0
    );
    assert.doesNotMatch(api.calls[0]!.path, /after=/);
    assert.equal(harness.calls.length, 1);
    assert.deepEqual(api.calls.find((entry) => entry.path === "/wakes")!.body, {
      integration: "codex",
      handoff_id: handoffId
    });
  } finally {
    await env.cleanup();
  }
});

test("dry-run prints argv and neither spawns, records a wake nor saves state", async () => {
  const env = await fixture();
  await writeFile(
    join(env.home, ".orchestrat", "config.json"),
    JSON.stringify({
      ...(await readJson(join(env.home, ".orchestrat", "config.json"))),
      waker: enabled(env.cwd, ["thread-9"])
    })
  );
  try {
    const api = fakeApi({
      waits: [
        {
          status: "updates",
          events: [handoffEvent(5)],
          cursor: "5",
          attention: summary
        }
      ]
    });
    const harness = fakeSpawn("{}");
    const run = deps({ fetch: api.fetch, spawn: harness.spawn });
    assert.equal(
      await runWakerCommand(["run", "--once", "--dry-run"], env.ctx, run.deps),
      0
    );
    assert.equal(harness.calls.length, 0);
    assert.equal(
      api.calls.filter((entry) => entry.path === "/wakes").length,
      0
    );
    assert.ok(
      run.out
        .join("")
        .includes(
          JSON.stringify([
            "codex",
            "exec",
            "resume",
            "thread-9",
            "--json",
            WAKE_PROMPT
          ])
        )
    );
    await assert.rejects(
      readFile(join(env.home, ".orchestrat", "waker", "state.json"))
    );
  } finally {
    await env.cleanup();
  }
});

test("enable refuses without a TTY and changes nothing", async () => {
  const env = await fixture();
  try {
    const before = await readFile(
      join(env.home, ".orchestrat", "config.json"),
      "utf8"
    );
    const run = deps({
      isTTY: false,
      stdin: Readable.from([`${ENABLE_CONFIRMATION}\n`])
    });
    assert.equal(await runWakerCommand(["enable"], env.ctx, run.deps), 1);
    assert.match(run.err.join(""), /interactive terminal/);
    assert.equal(
      await readFile(join(env.home, ".orchestrat", "config.json"), "utf8"),
      before
    );
  } finally {
    await env.cleanup();
  }
});

test("enable shows argv, limits and permissions and needs the typed confirmation", async () => {
  const env = await fixture();
  try {
    const declined = deps({ isTTY: true, stdin: Readable.from(["yes\n"]) });
    assert.equal(await runWakerCommand(["enable"], env.ctx, declined.deps), 1);
    assert.equal(
      (await readJson(join(env.home, ".orchestrat", "config.json"))).waker,
      undefined
    );

    const accepted = deps({
      isTTY: true,
      stdin: Readable.from([`${ENABLE_CONFIRMATION}\n`])
    });
    assert.equal(await runWakerCommand(["enable"], env.ctx, accepted.deps), 0);
    const shown = accepted.out.join("");
    assert.ok(
      shown.includes(JSON.stringify(["codex", "exec", "--json", WAKE_PROMPT]))
    );
    assert.match(shown, /at least 5 min between wakes/);
    assert.match(shown, /normal permission settings/);
    assert.match(shown, /never adds\n?\s*--dangerously/);
    assert.match(shown, /Desktop sessions are never resumed/);
    const config = await readJson(join(env.home, ".orchestrat", "config.json"));
    assert.equal(config.waker.enabled, true);
    assert.deepEqual(config.waker.agents, [
      {
        project_id: PROJECT,
        integration: "codex",
        cwd: env.cwd,
        wake_on: ["handoff"],
        resume_foreign_sessions: false,
        owned_sessions: []
      }
    ]);

    assert.equal(await runWakerCommand(["disable"], env.ctx, deps({}).deps), 0);
    assert.equal(
      (await readJson(join(env.home, ".orchestrat", "config.json"))).waker
        .enabled,
      false
    );
    const disabled = deps({});
    assert.equal(
      await runWakerCommand(["run", "--once"], env.ctx, disabled.deps),
      1
    );
    assert.match(disabled.err.join(""), /disabled/);
  } finally {
    await env.cleanup();
  }
});

test("session ids are parsed from each harness's JSON output and must not look like flags", () => {
  assert.equal(
    parseSessionId(JSON.stringify({ type: "result", session_id: "abc-123" })),
    "abc-123"
  );
  assert.equal(
    parseSessionId(
      `noise\n${JSON.stringify({ type: "thread.started", thread_id: "t-1" })}\n{"type":"turn"}`
    ),
    "t-1"
  );
  assert.equal(
    parseSessionId(JSON.stringify({ session_id: "--dangerously-skip" })),
    undefined
  );
  assert.throws(() => harnessArgv("claude-code", "-rf"));
  assert.deepEqual(harnessArgv("claude-code", "s1"), [
    "claude",
    "-p",
    "--resume",
    "s1",
    "--output-format",
    "json",
    WAKE_PROMPT
  ]);
  for (const integration of Object.keys(
    HARNESS_COMMANDS
  ) as (keyof typeof HARNESS_COMMANDS)[])
    for (const argv of [
      harnessArgv(integration),
      harnessArgv(integration, "s1")
    ])
      assert.ok(!argv.some((arg) => /dangerously|yolo|bypass/i.test(arg)));
});

test("local budgets space wakes and cap them per hour and day", () => {
  const limits = DEFAULT_WAKER_LIMITS;
  assert.equal(nextWakeAt([], limits, T0), T0);
  assert.equal(nextWakeAt([T0 - 60_000], limits, T0), T0 + 4 * 60_000);
  const sixInHour = Array.from(
    { length: 6 },
    (_, index) => T0 - 50 * 60_000 + index * 6 * 60_000
  );
  assert.equal(
    nextWakeAt(sixInHour, limits, T0 + 10 * 60_000),
    sixInHour[0]! + 60 * 60_000
  );
  const twentyInDay = Array.from(
    { length: 20 },
    (_, index) => T0 - 23 * 3_600_000 + (index * 60 * 60_000) / 2
  );
  assert.ok(
    nextWakeAt(twentyInDay, limits, T0) >= twentyInDay[0]! + 24 * 3_600_000
  );
});
