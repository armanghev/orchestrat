import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions
} from "node:child_process";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm
} from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { AgentApiClient, AgentApiError } from "@orchestrat/sdk";
import {
  canonicalizeCwd,
  configPath,
  findMapping,
  findProject,
  INTEGRATIONS,
  readConfig,
  type Integration
} from "./config.js";
import type { CredentialReader } from "./keychain.js";
import { resolveInvocation } from "./resolve.js";
import { atomicWrite, readOptional } from "./safe-files.js";

// Local waker. Opt-in and foreground only: it long-polls the attention wait
// endpoint for each configured agent and, when work is handed to an agent with
// no online session, starts that agent's harness headlessly.

export const WAKE_KINDS = ["handoff", "direct_message", "mention"] as const;
export type WakeKind = (typeof WAKE_KINDS)[number];

export type WakerLimits = {
  min_interval_minutes: number;
  per_hour: number;
  per_day: number;
  max_run_minutes: number;
};
// These local budgets are ceilings: config may only make them stricter.
export const DEFAULT_WAKER_LIMITS: WakerLimits = {
  min_interval_minutes: 5,
  per_hour: 6,
  per_day: 20,
  max_run_minutes: 30
};

export type WakerAgent = {
  project_id: string;
  integration: Integration;
  cwd: string;
  wake_on: WakeKind[];
  resume_foreign_sessions: boolean;
  owned_sessions: string[];
};
export type WakerConfig = {
  enabled: boolean;
  agents: WakerAgent[];
  limits: WakerLimits;
};

// The prompt is a fixed template. Message and handoff bodies reach the agent
// only through tools it calls (get_attention), never through argv.
export const WAKE_PROMPT =
  "You were woken by Orchestrat because work was handed to you. Call get_attention and handle items addressed to you, then end your turn.";

// TODO-verify-against---help: spellings follow each vendor's CLI docs. ATT-11
// re-checks each against the installed CLI's `--help` before the waker leaves
// alpha. Tests never run these binaries. Runs use the harness's normal
// permission settings: nothing here may add --dangerously-* or any other
// permission-bypass flag.
export const HARNESS_COMMANDS: Record<
  Integration,
  {
    binary: string;
    start: (prompt: string) => string[];
    resume: (sessionId: string, prompt: string) => string[];
  }
> = {
  "claude-code": {
    binary: "claude",
    start: (prompt) => ["-p", prompt, "--output-format", "json"],
    resume: (id, prompt) => [
      "-p",
      "--resume",
      id,
      "--output-format",
      "json",
      prompt
    ]
  },
  codex: {
    binary: "codex",
    start: (prompt) => ["exec", "--json", prompt],
    resume: (id, prompt) => ["exec", "resume", id, "--json", prompt]
  },
  cursor: {
    binary: "agent",
    start: (prompt) => ["-p", prompt, "--output-format", "json"],
    resume: (id, prompt) => [
      "--resume",
      id,
      "-p",
      "--output-format",
      "json",
      prompt
    ]
  },
  antigravity: {
    binary: "agy",
    start: (prompt) => ["-p", prompt, "--output-format", "json"],
    resume: (id, prompt) => [
      "-p",
      prompt,
      "--conversation",
      id,
      "--output-format",
      "json"
    ]
  }
};

// Session ids are placed in argv, so they must not look like flags.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MAX_OWNED_SESSIONS = 10;

export function harnessArgv(
  integration: Integration,
  sessionId?: string
): string[] {
  const harness = HARNESS_COMMANDS[integration];
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId))
    throw new Error("Invalid waker session id");
  const argv = [
    harness.binary,
    ...(sessionId === undefined
      ? harness.start(WAKE_PROMPT)
      : harness.resume(sessionId, WAKE_PROMPT))
  ];
  if (argv.some((arg) => /^--dangerously/i.test(arg)))
    throw new Error("The waker never adds permission-bypass flags");
  return argv;
}

// Harness JSON output carries the session id under different keys: Claude and
// Cursor `session_id`, Codex `thread_id`, Antigravity
// `conversation_id` (TODO-verify-against---help with the table above).
const SESSION_KEYS = [
  "session_id",
  "thread_id",
  "sessionId",
  "conversation_id",
  "conversationId",
  "chat_id",
  "chatId"
];

function findSessionId(value: unknown, depth: number): string | undefined {
  if (depth > 3 || !value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) {
      const id = findSessionId(item, depth + 1);
      if (id) return id;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of SESSION_KEYS) {
    const candidate = record[key];
    if (typeof candidate === "string" && SESSION_ID_PATTERN.test(candidate))
      return candidate;
  }
  for (const nested of Object.values(record)) {
    const id = findSessionId(nested, depth + 1);
    if (id) return id;
  }
  return undefined;
}

export function parseSessionId(output: string): string | undefined {
  const documents: unknown[] = [];
  try {
    documents.push(JSON.parse(output));
  } catch {
    // JSON Lines (Codex) or a single object after log noise.
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
      try {
        documents.push(JSON.parse(trimmed));
      } catch {
        // Partial line at a capture boundary.
      }
    }
  }
  for (const document of documents) {
    const id = findSessionId(document, 0);
    if (id) return id;
  }
  return undefined;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Earliest time the next wake is allowed under the local budgets.
export function nextWakeAt(
  wakes: number[],
  limits: WakerLimits,
  now: number
): number {
  const recent = wakes.filter((at) => at > now - DAY).sort((a, b) => a - b);
  let allowed = now;
  const last = recent.at(-1);
  if (last !== undefined)
    allowed = Math.max(allowed, last + limits.min_interval_minutes * MINUTE);
  const hour = recent.filter((at) => at > now - HOUR);
  if (hour.length >= limits.per_hour)
    allowed = Math.max(allowed, hour[hour.length - limits.per_hour]! + HOUR);
  if (recent.length >= limits.per_day)
    allowed = Math.max(allowed, recent[recent.length - limits.per_day]! + DAY);
  return allowed;
}

// Config: the "waker" key of ~/.orchestrat/config.json. config.ts keeps it
// as an opaque record; this module owns its shape.

function positiveInt(value: unknown, fallback: number, name: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new Error(`Invalid waker limit ${name}`);
  return value;
}

function parseLimits(value: unknown): WakerLimits {
  if (value === undefined) return { ...DEFAULT_WAKER_LIMITS };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid waker limits");
  const input = value as Record<string, unknown>;
  const limits = {
    min_interval_minutes: positiveInt(
      input.min_interval_minutes,
      DEFAULT_WAKER_LIMITS.min_interval_minutes,
      "min_interval_minutes"
    ),
    per_hour: positiveInt(
      input.per_hour,
      DEFAULT_WAKER_LIMITS.per_hour,
      "per_hour"
    ),
    per_day: positiveInt(
      input.per_day,
      DEFAULT_WAKER_LIMITS.per_day,
      "per_day"
    ),
    max_run_minutes: positiveInt(
      input.max_run_minutes,
      DEFAULT_WAKER_LIMITS.max_run_minutes,
      "max_run_minutes"
    )
  };
  if (
    limits.min_interval_minutes < DEFAULT_WAKER_LIMITS.min_interval_minutes ||
    limits.per_hour > DEFAULT_WAKER_LIMITS.per_hour ||
    limits.per_day > DEFAULT_WAKER_LIMITS.per_day ||
    limits.max_run_minutes > DEFAULT_WAKER_LIMITS.max_run_minutes
  )
    throw new Error("Waker limits may only be stricter than the defaults");
  return limits;
}

function parseAgent(value: unknown): WakerAgent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid waker agent");
  const input = value as Record<string, unknown>;
  const text = (field: unknown) =>
    typeof field === "string" && field.trim().length > 0;
  if (
    !text(input.project_id) ||
    !text(input.cwd) ||
    !(INTEGRATIONS as readonly unknown[]).includes(input.integration)
  )
    throw new Error("Invalid waker agent");
  const wakeOn = input.wake_on === undefined ? ["handoff"] : input.wake_on;
  if (
    !Array.isArray(wakeOn) ||
    !wakeOn.length ||
    wakeOn.some((kind) => !(WAKE_KINDS as readonly unknown[]).includes(kind))
  )
    throw new Error("Invalid waker wake_on");
  const owned = input.owned_sessions ?? [];
  if (
    !Array.isArray(owned) ||
    owned.some((id) => typeof id !== "string" || !SESSION_ID_PATTERN.test(id))
  )
    throw new Error("Invalid waker owned_sessions");
  if (
    input.resume_foreign_sessions !== undefined &&
    typeof input.resume_foreign_sessions !== "boolean"
  )
    throw new Error("Invalid waker resume_foreign_sessions");
  return {
    project_id: input.project_id as string,
    integration: input.integration as Integration,
    cwd: input.cwd as string,
    wake_on: [...new Set(wakeOn as WakeKind[])],
    resume_foreign_sessions: input.resume_foreign_sessions === true,
    owned_sessions: (owned as string[]).slice(-MAX_OWNED_SESSIONS)
  };
}

export function parseWakerConfig(value: unknown): WakerConfig {
  if (value === undefined)
    return { enabled: false, agents: [], limits: { ...DEFAULT_WAKER_LIMITS } };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid waker config");
  const input = value as Record<string, unknown>;
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw new Error("Invalid waker config");
  if (input.agents !== undefined && !Array.isArray(input.agents))
    throw new Error("Invalid waker config");
  return {
    enabled: input.enabled === true,
    agents: ((input.agents as unknown[] | undefined) ?? []).map(parseAgent),
    limits: parseLimits(input.limits)
  };
}

async function readRawConfig(home: string): Promise<Record<string, unknown>> {
  const text = await readOptional(configPath(home));
  if (text === undefined) return { version: 1, projects: {} };
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Orchestrat config");
  return value as Record<string, unknown>;
}

export async function readWakerConfig(home: string): Promise<WakerConfig> {
  return parseWakerConfig((await readRawConfig(home)).waker);
}

// Rewrites only the "waker" key and preserves every other key verbatim.
async function updateWakerConfig(
  home: string,
  update: (config: WakerConfig) => WakerConfig
) {
  const raw = await readRawConfig(home);
  const next = update(parseWakerConfig(raw.waker));
  raw.waker = next;
  await atomicWrite(configPath(home), `${JSON.stringify(raw, null, 2)}\n`);
  return next;
}

const agentKey = (
  agent: Pick<WakerAgent, "project_id" | "integration" | "cwd">
) => `${agent.project_id}:${agent.integration}:${agent.cwd}`;
const agentLabel = (agent: WakerAgent) =>
  `${agent.integration}@${agent.project_id.slice(0, 8)}`;

// Runtime state (cursor, wake history, deferred items) survives restarts so a
// restart can never reset the local budget.

type PendingItem = {
  kind: WakeKind;
  handoff_id: string | null;
  event_id: number | null;
};
type AgentState = { cursor?: string; wakes: number[]; pending: PendingItem[] };
type WakerState = { version: 1; agents: Record<string, AgentState> };

const wakerDir = (home: string) => join(home, ".orchestrat", "waker");
const statePath = (home: string) => join(wakerDir(home), "state.json");
const lockPath = (home: string) => join(wakerDir(home), "run.lock");
export const wakerLogPath = (home: string) =>
  join(home, ".orchestrat", "logs", "waker.log");
const LOG_ROTATE_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;

function parseState(text: string | undefined): WakerState {
  const empty: WakerState = { version: 1, agents: {} };
  if (text === undefined || text.length > MAX_STATE_BYTES) return empty;
  try {
    const value = JSON.parse(text) as {
      version?: unknown;
      agents?: Record<string, unknown>;
    };
    if (
      value.version !== 1 ||
      !value.agents ||
      typeof value.agents !== "object"
    )
      return empty;
    const agents: Record<string, AgentState> = {};
    for (const [key, raw] of Object.entries(value.agents)) {
      const entry = raw as Partial<AgentState>;
      agents[key] = {
        ...(typeof entry.cursor === "string" && /^\d+$/.test(entry.cursor)
          ? { cursor: entry.cursor }
          : {}),
        wakes: Array.isArray(entry.wakes)
          ? entry.wakes.filter((at) => Number.isFinite(at)).slice(-100)
          : [],
        pending: Array.isArray(entry.pending)
          ? entry.pending
              .filter(
                (item) =>
                  item &&
                  (WAKE_KINDS as readonly unknown[]).includes(item.kind) &&
                  (item.handoff_id === null ||
                    typeof item.handoff_id === "string")
              )
              .slice(-50)
          : []
      };
    }
    return { version: 1, agents };
  } catch {
    return empty;
  }
}

type WakerClient = Pick<AgentApiClient, "attention" | "getPresence">;

export type WakerContext = {
  home: string;
  cwd: string;
  api?: string;
  credentials: CredentialReader;
};

export type WakerDeps = {
  spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions
  ) => ChildProcess;
  now: () => number;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  fetch?: typeof globalThis.fetch;
  createClient: (options: { baseUrl: string; token: string }) => WakerClient;
  isTTY: boolean;
  stdin: NodeJS.ReadableStream;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signal?: AbortSignal;
  pid: number;
  isProcessAlive: (pid: number) => boolean;
};

function defaultSleep(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultDeps(overrides: Partial<WakerDeps>): WakerDeps {
  const fetch = overrides.fetch;
  return {
    spawn: (command, args, options) => nodeSpawn(command, args, options),
    now: () => Date.now(),
    sleep: defaultSleep,
    createClient: (options) => new AgentApiClient({ ...options, fetch }),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    stdin: process.stdin,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    pid: process.pid,
    isProcessAlive: processAlive,
    ...overrides
  };
}

class WakerLog {
  private chain = Promise.resolve();
  private failed = false;

  constructor(
    private readonly home: string,
    private readonly deps: WakerDeps
  ) {}

  // Lines hold ids, kinds and counts only, never message text or tokens.
  write(line: string) {
    const text = `${new Date(this.deps.now()).toISOString()} ${line}\n`;
    this.deps.stdout(text);
    this.chain = this.chain.then(() => this.append(text));
    return this.chain;
  }

  flush() {
    return this.chain;
  }

  private async append(text: string) {
    const path = wakerLogPath(this.home);
    try {
      await mkdir(join(this.home, ".orchestrat", "logs"), {
        recursive: true,
        mode: 0o700
      });
      const current = await lstat(path).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }
      );
      if (current?.isSymbolicLink() || (current && !current.isFile()))
        throw new Error("Refusing to write a non-regular waker log");
      if (current && current.size + text.length > LOG_ROTATE_BYTES)
        await rename(path, `${path}.1`);
      await appendFile(path, text, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      if (!this.failed)
        this.deps.stderr(
          `Waker log unavailable: ${(error as Error).message}\n`
        );
      this.failed = true;
    }
  }
}

// One waker process per home: the loop runs each agent's harness to
// completion before waiting again, so this also bounds each agent to one
// running process.
async function acquireLock(home: string, deps: WakerDeps) {
  const path = lockPath(home);
  await mkdir(wakerDir(home), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(deps.pid));
      await handle.close();
      return async () => {
        await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(
        (await readFile(path, "utf8").catch(() => "")).trim()
      );
      if (Number.isInteger(owner) && owner > 0 && deps.isProcessAlive(owner))
        return undefined;
      await rm(path, { force: true });
    }
  }
  return undefined;
}

// Keeps the first and last MiB of harness stdout: session ids appear in the
// first event (Codex) or the final result object (Claude, Cursor).
class OutputCapture {
  private static readonly LIMIT = 1024 * 1024;
  private head = "";
  private tail = "";
  private headFull = false;

  push(text: string) {
    if (!this.headFull) {
      const room = OutputCapture.LIMIT - this.head.length;
      this.head += text.slice(0, room);
      if (text.length <= room) return;
      this.headFull = true;
      text = text.slice(room);
    }
    this.tail = (this.tail + text).slice(-OutputCapture.LIMIT);
  }

  sessionId() {
    return parseSessionId(this.head) ?? parseSessionId(this.tail);
  }
}

type RunResult = { code: number | null; sessionId?: string; error?: string };
type Outcome = "woken" | "skipped" | "deferred";

type AgentRuntime = {
  agent: WakerAgent;
  key: string;
  agentId: string;
  client: WakerClient;
};

class WakerRunner {
  private state: WakerState = { version: 1, agents: {} };
  private writes = Promise.resolve();

  constructor(
    private readonly ctx: WakerContext,
    private readonly deps: WakerDeps,
    private readonly config: WakerConfig,
    private readonly log: WakerLog,
    private readonly options: { once: boolean; dryRun: boolean },
    // Aborted by the user (kills running harnesses) ...
    private readonly signal: AbortSignal,
    // ... or, with --once, when another agent has handled its event.
    private readonly waitSignal: AbortSignal
  ) {}

  async load() {
    this.state = parseState(await readOptional(statePath(this.ctx.home)));
  }

  flush() {
    return this.writes;
  }

  private agentState(key: string) {
    return (this.state.agents[key] ??= { wakes: [], pending: [] });
  }

  private persist(task: () => Promise<unknown>) {
    // Dry runs never persist: a later real run must still see these events.
    if (this.options.dryRun) return this.writes;
    this.writes = this.writes.then(task, task).then(
      () => undefined,
      (error: Error) => {
        this.deps.stderr(`Waker state not saved: ${error.message}\n`);
      }
    );
    return this.writes;
  }

  private saveState() {
    return this.persist(() =>
      atomicWrite(
        statePath(this.ctx.home),
        `${JSON.stringify(this.state)}\n`,
        false
      )
    );
  }

  private updateOwnedSessions(
    agent: WakerAgent,
    change: (owned: string[]) => string[]
  ) {
    agent.owned_sessions = change(agent.owned_sessions).slice(
      -MAX_OWNED_SESSIONS
    );
    return this.persist(() =>
      updateWakerConfig(this.ctx.home, (config) => ({
        ...config,
        agents: config.agents.map((entry) =>
          agentKey(entry) === agentKey(agent)
            ? { ...entry, owned_sessions: agent.owned_sessions }
            : entry
        )
      }))
    );
  }

  async runAgent(runtime: AgentRuntime) {
    const { agent } = runtime;
    const state = this.agentState(runtime.key);
    if (agent.resume_foreign_sessions)
      await this.log.write(
        `${agentLabel(agent)} resume_foreign_sessions is not supported; only waker-owned sessions are resumed`
      );
    while (!this.waitSignal.aborted) {
      if (state.pending.length) {
        const outcome = await this.processPending(runtime, state, false);
        if (outcome !== "deferred" && this.options.once) return;
      }
      const now = this.deps.now();
      const timeout = state.pending.length
        ? Math.min(
            25_000,
            Math.max(
              5_000,
              nextWakeAt(state.wakes, this.config.limits, now) - now
            )
          )
        : 25_000;
      let response: Awaited<ReturnType<WakerClient["attention"]["wait"]>>;
      try {
        response = await runtime.client.attention.wait(
          {
            ...(state.cursor ? { after: state.cursor } : {}),
            timeout_ms: timeout,
            directed_only: true,
            kinds: agent.wake_on.join(",")
          },
          this.waitSignal
        );
      } catch (error) {
        if (this.waitSignal.aborted) return;
        const code = error instanceof AgentApiError ? error.code : "ERROR";
        const status = error instanceof AgentApiError ? error.status : 0;
        await this.log.write(`${agentLabel(agent)} wait failed (${code})`);
        if (status === 401 || status === 403 || this.options.once) throw error;
        await this.deps.sleep(5_000, this.waitSignal);
        continue;
      }
      state.cursor = response.cursor;
      const known = new Set(state.pending.map(pendingKey));
      const fresh = qualifyingItems(response, agent.wake_on).filter(
        (item) => !known.has(pendingKey(item))
      );
      state.pending.push(...fresh);
      await this.saveState();
      if (!fresh.length) continue;
      await this.log.write(
        `${agentLabel(agent)} ${fresh.length} new ${fresh.map((item) => item.kind).join(",")} item(s)`
      );
      await this.processPending(runtime, state, true);
      if (this.options.once) return;
    }
  }

  private async processPending(
    runtime: AgentRuntime,
    state: AgentState,
    fresh: boolean
  ): Promise<Outcome> {
    const { agent } = runtime;
    const label = agentLabel(agent);
    const now = this.deps.now();
    const allowedAt = nextWakeAt(state.wakes, this.config.limits, now);
    if (allowedAt > now) {
      if (fresh)
        await this.log.write(
          `${label} deferred until ${new Date(allowedAt).toISOString()} (local budget)`
        );
      return "deferred";
    }
    // A live session sees the item through wait_for_update or its hooks.
    let online: boolean;
    try {
      const presence = await runtime.client.getPresence();
      online = presence.agents.some(
        (entry) =>
          entry.agent_id === runtime.agentId && entry.status === "online"
      );
    } catch (error) {
      const code = error instanceof AgentApiError ? error.code : "ERROR";
      await this.log.write(
        `${label} presence check failed (${code}); deferred`
      );
      return "deferred";
    }
    if (online) {
      state.pending = [];
      await this.saveState();
      await this.log.write(`${label} skipped: agent has an online session`);
      return "skipped";
    }
    if (!(await this.recordWake(runtime, state))) {
      await this.saveState();
      return "skipped";
    }
    // One run handles every pending item: the prompt says to call
    // get_attention, which lists all of them.
    const sessionId = agent.owned_sessions.at(-1);
    const argv = harnessArgv(agent.integration, sessionId);
    state.wakes.push(now);
    state.pending = [];
    await this.saveState();
    if (this.options.dryRun) {
      this.deps.stdout(
        `[dry-run] ${label} would run in ${agent.cwd}: ${JSON.stringify(argv)}\n`
      );
      return "woken";
    }
    await this.log.write(
      `${label} wake: ${sessionId ? `resuming waker session ${sessionId}` : "starting a new headless session"}`
    );
    const result = await this.runHarness(argv, agent.cwd);
    if (result.sessionId && !agent.owned_sessions.includes(result.sessionId))
      await this.updateOwnedSessions(agent, (owned) => [
        ...owned,
        result.sessionId!
      ]);
    else if (!result.sessionId && sessionId && result.code !== 0)
      // The resumed session is gone or unusable; the next wake starts fresh.
      await this.updateOwnedSessions(agent, (owned) =>
        owned.filter((id) => id !== sessionId)
      );
    await this.log.write(
      `${label} run ended (${result.error ?? `exit ${result.code ?? "signal"}`})${result.sessionId ? ` session ${result.sessionId}` : ""}`
    );
    return "woken";
  }

  private async recordWake(runtime: AgentRuntime, state: AgentState) {
    const label = agentLabel(runtime.agent);
    if (this.options.dryRun) {
      this.deps.stdout(
        `[dry-run] ${label} would record a wake for ${state.pending[0]?.handoff_id ?? "a directed item"}\n`
      );
      return true;
    }
    while (state.pending.length) {
      const item = state.pending[0]!;
      try {
        await runtime.client.attention.recordWake({
          integration: runtime.agent.integration,
          handoff_id: item.handoff_id
        });
        return true;
      } catch (error) {
        state.pending.shift();
        if (error instanceof AgentApiError && error.status === 429)
          await this.log.write(
            `${label} budget: server refused wake (${error.code})`
          );
        else
          // Fail closed: without a recorded wake there is no server budget
          // check, so the waker must not spawn.
          await this.log.write(
            `${label} wake not recorded (${error instanceof AgentApiError ? error.code : "ERROR"}); skipped`
          );
      }
    }
    return false;
  }

  private runHarness(argv: string[], cwd: string): Promise<RunResult> {
    const limitMs = this.config.limits.max_run_minutes * MINUTE;
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        // argv array, no shell: nothing in it is interpreted.
        child = this.deps.spawn(argv[0]!, argv.slice(1), {
          cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });
      } catch (error) {
        resolve({ code: null, error: (error as Error).message });
        return;
      }
      const capture = new OutputCapture();
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => capture.push(chunk));
      child.stderr?.resume();
      let settled = false;
      let timedOut = false;
      const kill = () => {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 10_000).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, limitMs);
      timer.unref();
      this.signal.addEventListener("abort", kill, { once: true });
      const finish = (result: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.signal.removeEventListener("abort", kill);
        resolve({
          ...result,
          sessionId: capture.sessionId(),
          ...(timedOut
            ? {
                error: `killed after ${this.config.limits.max_run_minutes} min`
              }
            : {})
        });
      };
      child.once("error", (error: NodeJS.ErrnoException) =>
        finish({
          code: null,
          error:
            error.code === "ENOENT"
              ? `${argv[0]} not found on PATH`
              : "spawn failed"
        })
      );
      child.once("close", (code: number | null) => finish({ code }));
    });
  }
}

const pendingKey = (item: PendingItem) =>
  item.handoff_id ?? `event:${item.event_id ?? "snapshot"}:${item.kind}`;

function qualifyingItems(
  response: Awaited<ReturnType<WakerClient["attention"]["wait"]>>,
  wakeOn: WakeKind[]
): PendingItem[] {
  // Without a cursor the server answers "pending" with a level snapshot. Only
  // its handoffs carry ids, so they are the only snapshot items that wake.
  if (response.status === "pending")
    return wakeOn.includes("handoff")
      ? response.attention.handoffs.map((handoff) => ({
          kind: "handoff",
          handoff_id: handoff.handoff_id,
          event_id: null
        }))
      : [];
  return response.events
    .filter((event) => (wakeOn as string[]).includes(event.kind))
    .map((event) => ({
      kind: event.kind as WakeKind,
      handoff_id: event.kind === "handoff" ? (event.handoff_id ?? null) : null,
      event_id: event.event_id
    }));
}

async function resolveAgent(
  agent: WakerAgent,
  ctx: WakerContext,
  deps: WakerDeps
): Promise<AgentRuntime> {
  const config = await readConfig(ctx.home);
  const mapping = findMapping(config, agent.cwd, agent.integration);
  if (!mapping || mapping.projectId !== agent.project_id)
    throw new Error(
      `No ${agent.integration} project mapping for ${agent.cwd}; run orchestrat setup`
    );
  const resolved = await resolveInvocation({
    api: mapping.apiUrl ?? ctx.api,
    cwd: agent.cwd,
    home: ctx.home,
    integration: agent.integration,
    read: () => Promise.resolve(config),
    credentials: ctx.credentials
  });
  return {
    agent,
    key: agentKey(agent),
    agentId: mapping.agentId,
    client: deps.createClient({
      baseUrl: resolved.api!,
      token: resolved.credential!
    })
  };
}

const USAGE =
  "Usage: orchestrat waker enable [--integration <name>]... [--wake-on handoff,direct_message,mention]\n" +
  "       orchestrat waker disable | status\n" +
  "       orchestrat waker run [--once] [--dry-run]\n";

type ParsedArgs = {
  action: string;
  once: boolean;
  dryRun: boolean;
  integrations: Integration[];
  wakeOn?: WakeKind[];
};

const ACTION_FLAGS: Record<string, readonly string[]> = {
  enable: ["--integration", "--wake-on"],
  disable: [],
  status: [],
  run: ["--once", "--dry-run"]
};

// Accepts `--flag value` and `--flag=value`. --integration may repeat;
// --wake-on takes a comma-separated list and repeats add to it.
function parseArgs(args: string[]): ParsedArgs | { error?: string } {
  const [action, ...rest] = args;
  if (!action || !Object.hasOwn(ACTION_FLAGS, action)) return {};
  const parsed: ParsedArgs = {
    action,
    once: false,
    dryRun: false,
    integrations: []
  };
  const integrations = new Set<Integration>();
  const wakeOn = new Set<WakeKind>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (!ACTION_FLAGS[action].includes(flag))
      return {
        error: flag.startsWith("-")
          ? `orchestrat waker ${action} does not accept ${flag}.`
          : `orchestrat waker ${action} does not take "${arg}".`
      };
    const takesValue = flag === "--integration" || flag === "--wake-on";
    if (!takesValue) {
      if (equals !== -1) return { error: `${flag} does not take a value.` };
      if (flag === "--once") parsed.once = true;
      else parsed.dryRun = true;
      continue;
    }
    const value = equals === -1 ? rest[++index] : arg.slice(equals + 1);
    if (flag === "--integration") {
      if (!(INTEGRATIONS as readonly unknown[]).includes(value))
        return {
          error:
            value === undefined || value === ""
              ? `--integration needs a value: ${INTEGRATIONS.join(", ")}.`
              : `Unknown integration "${value}" for --integration; use ${INTEGRATIONS.join(", ")}.`
        };
      integrations.add(value as Integration);
    } else {
      const kinds = (value ?? "")
        .split(",")
        .map((kind) => kind.trim())
        .filter(Boolean);
      const unknown = kinds.find(
        (kind) => !(WAKE_KINDS as readonly string[]).includes(kind)
      );
      if (!kinds.length || unknown !== undefined)
        return {
          error: kinds.length
            ? `Unknown wake kind "${unknown}" for --wake-on; use one or more of ${WAKE_KINDS.join(", ")}, comma-separated.`
            : `--wake-on needs one or more of ${WAKE_KINDS.join(", ")}, comma-separated.`
        };
      for (const kind of kinds) wakeOn.add(kind as WakeKind);
    }
  }
  parsed.integrations = [...integrations];
  if (wakeOn.size) parsed.wakeOn = [...wakeOn];
  return parsed;
}

async function readLine(stdin: NodeJS.ReadableStream) {
  const lines = createInterface({ input: stdin, terminal: false });
  try {
    for await (const line of lines) return line;
    return "";
  } finally {
    lines.close();
  }
}

export const ENABLE_CONFIRMATION = "enable waker";

function describeAgent(agent: WakerAgent, index: number) {
  return [
    `Agent ${index + 1}: ${agent.integration} in project ${agent.project_id}`,
    `  Working directory: ${agent.cwd}`,
    `  Wakes on: ${agent.wake_on.join(", ")}`,
    "  First wake starts a new headless session the waker owns:",
    `    ${JSON.stringify(harnessArgv(agent.integration))}`,
    "  Later wakes resume only that waker-owned session:",
    `    ${JSON.stringify(harnessArgv(agent.integration, "WAKER_SESSION_ID"))}`
  ].join("\n");
}

function describeLimits(limits: WakerLimits) {
  return (
    `Limits: at least ${limits.min_interval_minutes} min between wakes per agent, at most ${limits.per_hour} per hour and ${limits.per_day} per day, ` +
    `one running process per agent, killed after ${limits.max_run_minutes} min. ` +
    "The server also refuses wakes above 12 per hour or 30 per day per agent, and a second wake for the same handoff chain."
  );
}

async function enableCommand(
  parsed: ParsedArgs,
  ctx: WakerContext,
  deps: WakerDeps
) {
  if (!deps.isTTY) {
    deps.stderr(
      "orchestrat waker enable needs an interactive terminal to confirm; nothing was changed.\n"
    );
    return 1;
  }
  const cwd = canonicalizeCwd(ctx.cwd);
  const project = findProject(await readConfig(ctx.home), cwd);
  if (!project) {
    deps.stderr(
      `No Orchestrat project is set up for ${cwd}; run orchestrat setup first.\n`
    );
    return 1;
  }
  const mapped = Object.keys(project.integrations) as Integration[];
  const integrations = parsed.integrations.length
    ? parsed.integrations
    : mapped;
  const missing = integrations.filter((name) => !mapped.includes(name));
  if (!integrations.length || missing.length) {
    deps.stderr(
      `No agent is set up for ${missing.join(", ") || "this project"}; run orchestrat setup first.\n`
    );
    return 1;
  }
  const current = await readWakerConfig(ctx.home);
  const agents = integrations.map((integration) => {
    const agent = {
      project_id: project.projectId,
      integration,
      cwd
    };
    const existing = current.agents.find(
      (entry) => agentKey(entry) === agentKey(agent)
    );
    return {
      ...agent,
      wake_on: parsed.wakeOn ?? existing?.wake_on ?? ["handoff"],
      resume_foreign_sessions: false,
      owned_sessions: existing?.owned_sessions ?? []
    } satisfies WakerAgent;
  });
  deps.stdout(
    [
      "Orchestrat waker (opt-in)",
      "",
      "When work is handed to one of these agents and it has no online session, the waker",
      "starts its harness headlessly in the working directory below. The prompt is fixed;",
      "message text never reaches the command line, and no shell is involved.",
      "",
      ...agents.map(describeAgent),
      "",
      describeLimits(current.limits),
      "",
      "Permissions: runs use the harness's normal permission settings. The waker never adds",
      "--dangerously-* or other permission-bypass flags, so a run may stop at a prompt it cannot answer.",
      "",
      "Desktop sessions are never resumed. The desktop apps expose no supported way to add a turn",
      "to an open conversation (the Cursor and Antigravity CLIs cannot attach to IDE or desktop",
      "chats), and resuming a session a GUI still holds interleaves or forks its transcript.",
      "For desktop sessions use Claude Code's --rewake hook, wait_for_update, or the dashboard",
      "notification instead.",
      "",
      `Type "${ENABLE_CONFIRMATION}" to confirm: `
    ].join("\n")
  );
  const answer = (await readLine(deps.stdin)).trim();
  if (answer !== ENABLE_CONFIRMATION) {
    deps.stdout("\nNot enabled; nothing was changed.\n");
    return 1;
  }
  await updateWakerConfig(ctx.home, (config) => ({
    ...config,
    enabled: true,
    agents: [
      ...config.agents.filter(
        (entry) => !agents.some((agent) => agentKey(agent) === agentKey(entry))
      ),
      ...agents
    ]
  }));
  deps.stdout("\nWaker enabled. Start it with: orchestrat waker run\n");
  return 0;
}

async function statusCommand(ctx: WakerContext, deps: WakerDeps) {
  const config = await readWakerConfig(ctx.home);
  const state = parseState(await readOptional(statePath(ctx.home)));
  const now = deps.now();
  const lines = [`Waker: ${config.enabled ? "enabled" : "disabled"}`];
  if (!config.agents.length) lines.push("No agents configured.");
  for (const agent of config.agents) {
    const entry = state.agents[agentKey(agent)] ?? { wakes: [], pending: [] };
    const allowed = nextWakeAt(entry.wakes, config.limits, now);
    lines.push(
      `${agent.integration} in project ${agent.project_id} (${agent.cwd})`,
      `  wakes on: ${agent.wake_on.join(", ")}; waker session: ${agent.owned_sessions.at(-1) ?? "none yet"}`,
      `  wakes in the last hour: ${entry.wakes.filter((at) => at > now - HOUR).length}, last day: ${entry.wakes.filter((at) => at > now - DAY).length}; pending: ${entry.pending.length}; next wake: ${allowed > now ? new Date(allowed).toISOString() : "now"}`
    );
  }
  lines.push(describeLimits(config.limits), `Log: ${wakerLogPath(ctx.home)}`);
  deps.stdout(`${lines.join("\n")}\n`);
  return 0;
}

async function runCommand(
  parsed: ParsedArgs,
  ctx: WakerContext,
  deps: WakerDeps
) {
  const config = await readWakerConfig(ctx.home);
  if (!config.enabled && !parsed.dryRun) {
    deps.stderr("The waker is disabled; run orchestrat waker enable first.\n");
    return 1;
  }
  if (!config.agents.length) {
    deps.stderr(
      "No waker agents are configured; run orchestrat waker enable.\n"
    );
    return 1;
  }
  const runtimes: AgentRuntime[] = [];
  for (const agent of config.agents) {
    try {
      runtimes.push(await resolveAgent(agent, ctx, deps));
    } catch (error) {
      deps.stderr(`${agentLabel(agent)}: ${(error as Error).message}\n`);
      return 1;
    }
  }
  const release = parsed.dryRun ? undefined : await acquireLock(ctx.home, deps);
  if (!parsed.dryRun && !release) {
    deps.stderr("Another waker is already running for this user.\n");
    return 1;
  }
  const stop = new AbortController();
  const waits = new AbortController();
  const abort = () => {
    stop.abort();
    waits.abort();
  };
  const external = deps.signal;
  if (external?.aborted) abort();
  external?.addEventListener("abort", abort, { once: true });
  if (!external) {
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
  }
  const log = new WakerLog(ctx.home, deps);
  const runner = new WakerRunner(
    ctx,
    deps,
    config,
    log,
    { once: parsed.once, dryRun: parsed.dryRun },
    stop.signal,
    waits.signal
  );
  try {
    await runner.load();
    await log.write(
      `waker started for ${runtimes.length} agent(s)${parsed.dryRun ? " (dry run)" : ""}`
    );
    const results = await Promise.allSettled(
      runtimes.map((runtime) =>
        runner.runAgent(runtime).finally(() => {
          if (parsed.once) waits.abort();
        })
      )
    );
    await runner.flush();
    const failed = results.filter((result) => result.status === "rejected");
    await log.write(
      `waker stopped${failed.length ? ` (${failed.length} agent error(s))` : ""}`
    );
    return failed.length ? 1 : 0;
  } finally {
    await log.flush();
    external?.removeEventListener("abort", abort);
    if (!external) {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
    await release?.();
  }
}

export async function runWakerCommand(
  args: string[],
  ctx: WakerContext,
  overrides: Partial<WakerDeps> = {}
): Promise<number> {
  const deps = defaultDeps(overrides);
  const parsed = parseArgs(args);
  if (!("action" in parsed)) {
    deps.stderr(parsed.error ? `${parsed.error}\n${USAGE}` : USAGE);
    return 1;
  }
  try {
    if (parsed.action === "enable")
      return await enableCommand(parsed, ctx, deps);
    if (parsed.action === "disable") {
      await updateWakerConfig(ctx.home, (config) => ({
        ...config,
        enabled: false
      }));
      deps.stdout("Waker disabled.\n");
      return 0;
    }
    if (parsed.action === "status") return await statusCommand(ctx, deps);
    return await runCommand(parsed, ctx, deps);
  } catch (error) {
    deps.stderr(`${(error as Error).message}\n`);
    return 1;
  }
}
