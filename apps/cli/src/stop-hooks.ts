import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentApiClient, type AttentionApi } from "@orchestrat/sdk";
import {
  continuesOnStop,
  readConfig,
  rewakeEnabled,
  type OrchestratConfig
} from "./config.js";
import { clientForCheckout } from "./branches.js";
import type { ConfigurableIntegration } from "./harnesses.js";
import { externalSessionId } from "./hook-types.js";
import { hookCwd } from "./hooks.js";
import type { CredentialReader } from "./keychain.js";
import { resolveInvocation } from "./resolve.js";
import { readPrivateState, writePrivateState } from "./safe-files.js";

type WaitResponse = Awaited<ReturnType<AttentionApi["wait"]>>;
type AttentionSummary = WaitResponse["attention"];
type WaitEvent = WaitResponse["events"][number];

// Stop-hook continuation. Every path fails open: an error, timeout, missing
// credential or missing opt-in allows the stop.
export const STOP_BUDGET_MS = 2000;
export const MAX_BLOCKS = 3;
export const BLOCK_WINDOW_MS = 30 * 60 * 1000;
export const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const WATCH_MAX_MS = 55 * 60 * 1000;
const WAIT_ROUND_MS = 25_000;
const MAX_SESSIONS = 500;
const MAX_SEEN = 200;

export type StopDecision =
  { continue: false; why: string } | { continue: true; reason: string };

export type StopHookInput = {
  integration: ConfigurableIntegration;
  payload: unknown;
  cwd: string;
  home: string;
  api?: string;
  credentials: CredentialReader;
  read?: () => Promise<OrchestratConfig>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  budgetMs?: number;
};

type SessionState = {
  cursor?: string;
  blocks: number[];
  seen: string[];
  updated_at: number;
};
type StopState = { version: 1; sessions: Record<string, SessionState> };

type ParsedStop = {
  external: string;
  cwd: string;
  // The harness is already continuing because of a Stop hook.
  active: boolean;
  // False when the turn ended by user abort or error; never continue those.
  eligible: boolean;
};

export const stopStatePath = (home: string) =>
  join(home, ".orchestrat", "hooks", "stop-state.json");

const sessionKey = (integration: string, external: string) =>
  `${integration}:${createHash("sha256").update(external).digest("hex").slice(0, 32)}`;

export const rewakeLockPath = (home: string, external: string) =>
  join(
    home,
    ".orchestrat",
    "hooks",
    `rewake-${sessionKey("claude-code", external).split(":")[1]}.lock`
  );

export function parseStopPayload(
  integration: ConfigurableIntegration,
  payload: unknown
): ParsedStop | undefined {
  const external = externalSessionId(integration, payload);
  if (!external || !payload || typeof payload !== "object") return undefined;
  const input = payload as Record<string, unknown>;
  const cwd = hookCwd(integration, payload, "");
  if (integration === "claude-code" || integration === "codex") {
    if (input.hook_event_name !== "Stop" || !cwd) return undefined;
    return {
      external,
      cwd,
      active: input.stop_hook_active === true,
      eligible: true
    };
  }
  if (integration === "cursor") {
    if (input.hook_event_name !== "stop" || !cwd) return undefined;
    const loops = typeof input.loop_count === "number" ? input.loop_count : 0;
    return {
      external,
      cwd,
      active: loops > 0,
      eligible: input.status === undefined || input.status === "completed"
    };
  }
  if (integration === "antigravity") {
    if (!cwd) return undefined;
    const failed = typeof input.error === "string" && input.error.trim() !== "";
    return { external, cwd, active: false, eligible: !failed };
  }
  if (!cwd) return undefined;
  return { external, cwd, active: false, eligible: true };
}

function parseState(text: string | undefined): StopState {
  if (!text) return { version: 1, sessions: {} };
  try {
    const value = JSON.parse(text) as StopState;
    if (
      value?.version !== 1 ||
      !value.sessions ||
      typeof value.sessions !== "object"
    )
      return { version: 1, sessions: {} };
    const sessions: Record<string, SessionState> = {};
    for (const [key, raw] of Object.entries(value.sessions)) {
      if (!raw || typeof raw !== "object") continue;
      sessions[key] = {
        ...(typeof raw.cursor === "string" && /^[0-9]{1,19}$/.test(raw.cursor)
          ? { cursor: raw.cursor }
          : {}),
        blocks: Array.isArray(raw.blocks)
          ? raw.blocks.filter((item) => typeof item === "number")
          : [],
        seen: Array.isArray(raw.seen)
          ? raw.seen.filter((item) => typeof item === "string")
          : [],
        updated_at: typeof raw.updated_at === "number" ? raw.updated_at : 0
      };
    }
    return { version: 1, sessions };
  } catch {
    return { version: 1, sessions: {} };
  }
}

export async function readStopState(home: string) {
  return parseState(await readPrivateState(stopStatePath(home)));
}

// Read-modify-write of one session, pruning stale sessions (7 days) and
// bounding the file. Concurrent hooks for other sessions may lose a write;
// the atomic rename keeps the file valid either way.
async function updateSession(
  home: string,
  key: string,
  now: number,
  update: (session: SessionState) => SessionState
) {
  const state = await readStopState(home);
  const current = state.sessions[key] ?? {
    blocks: [],
    seen: [],
    updated_at: now
  };
  const next = update(current);
  state.sessions[key] = {
    ...next,
    blocks: next.blocks.filter((time) => now - time < BLOCK_WINDOW_MS),
    seen: next.seen.slice(-MAX_SEEN),
    updated_at: now
  };
  const kept = Object.entries(state.sessions)
    .filter(([, value]) => now - value.updated_at < STATE_TTL_MS)
    .sort(([, a], [, b]) => b.updated_at - a.updated_at)
    .slice(0, MAX_SESSIONS);
  await writePrivateState(
    stopStatePath(home),
    `${JSON.stringify({ version: 1, sessions: Object.fromEntries(kept) })}\n`
  );
}

type AttentionItem = {
  key: string;
  kind:
    | "handoff"
    | "direct_message"
    | "mention"
    | "comment"
    | "blocker_resolved"
    | "status_changed"
    | "claim_released";
  count: number;
  actor?: string;
  task?: string;
};

export function itemsFromSummary(summary: AttentionSummary): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const handoff of summary.handoffs)
    items.push({
      key: `handoff:${handoff.handoff_id}`,
      kind: "handoff",
      count: 1,
      actor: handoff.from.name,
      task: handoff.task?.key
    });
  for (const task of summary.tasks) {
    const key = `task:${task.task_id}:${task.latest_sequence}`;
    if (task.mention_count > 0)
      items.push({
        key,
        kind: "mention",
        count: task.mention_count,
        task: task.key
      });
    else if (
      (task.claimed_by_you && task.unread_count > 0) ||
      task.blocking_unread_count > 0
    )
      items.push({
        key,
        kind: "comment",
        count: task.claimed_by_you
          ? task.unread_count
          : task.blocking_unread_count,
        task: task.key
      });
  }
  for (const blocker of summary.blockers_resolved)
    items.push({
      key: `blocker:${blocker.block_id}`,
      kind: "blocker_resolved",
      count: 1,
      task: blocker.task.key
    });
  for (const chat of summary.unread_chats)
    if (chat.mention_count > 0)
      items.push({
        key: `chat:${chat.chat_id}:m${chat.mention_count}`,
        kind: "mention",
        count: chat.mention_count
      });
  return items;
}

export function itemsFromEvents(events: WaitEvent[]): AttentionItem[] {
  return events.map((event) => {
    const base = {
      count: 1,
      actor: event.actor?.name,
      task: event.task?.key
    };
    switch (event.kind) {
      case "handoff":
        return {
          ...base,
          key: `handoff:${event.handoff_id ?? `event-${event.event_id}`}`,
          kind: "handoff"
        };
      case "task_comment":
        return {
          ...base,
          key:
            event.task && event.comment_sequence
              ? `task:${event.task.id}:${event.comment_sequence}`
              : `event:${event.event_id}`,
          kind: "comment"
        };
      case "direct_message":
        return {
          ...base,
          key: `event:${event.event_id}`,
          kind: "direct_message"
        };
      case "mention":
        return { ...base, key: `event:${event.event_id}`, kind: "mention" };
      case "blocker_resolved":
        return {
          ...base,
          key: `event:${event.event_id}`,
          kind: "blocker_resolved"
        };
      case "claim_released":
        return {
          ...base,
          key: `event:${event.event_id}`,
          kind: "claim_released"
        };
      default:
        return {
          ...base,
          key: `event:${event.event_id}`,
          kind: "status_changed"
        };
    }
  });
}

// Names and keys are the only free text in the template. Both are clipped
// and reduced to a plain character set so they cannot carry instructions.
const safeName = (value: string | undefined) =>
  value
    ?.replace(/[^\p{L}\p{N} ._-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40) || undefined;
const safeKey = (value: string | undefined) =>
  value && /^[A-Za-z0-9]{1,16}-[0-9]{1,9}$/.test(value) ? value : undefined;
const list = (values: (string | undefined)[], limit = 3) => {
  const unique = [
    ...new Set(values.filter((value): value is string => !!value))
  ];
  if (!unique.length) return "";
  return unique.length > limit
    ? `${unique.slice(0, limit).join(", ")} and ${unique.length - limit} more`
    : unique.join(", ");
};
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

export function reasonTemplate(items: AttentionItem[]) {
  const phrases: string[] = [];
  const group = (kind: AttentionItem["kind"]) =>
    items.filter((item) => item.kind === kind);
  const total = (values: AttentionItem[]) =>
    values.reduce((sum, item) => sum + item.count, 0);
  const describe = (
    kind: AttentionItem["kind"],
    noun: string,
    options: { from?: boolean; on?: string } = {}
  ) => {
    const values = group(kind);
    if (!values.length) return;
    const actors = options.from
      ? list(values.map((item) => safeName(item.actor)))
      : "";
    const tasks = list(values.map((item) => safeKey(item.task)));
    phrases.push(
      `${plural(total(values), noun)}${actors ? ` from ${actors}` : ""}${
        tasks ? (options.on ? ` ${options.on} ${tasks}` : ` (${tasks})`) : ""
      }`
    );
  };
  describe("handoff", "handoff", { from: true });
  describe("direct_message", "direct message", { from: true });
  describe("mention", "mention", { from: true });
  describe("comment", "unread comment", { on: "on your claimed task" });
  describe("blocker_resolved", "resolved blocker");
  describe("claim_released", "released claim");
  describe("status_changed", "status change");
  return `Orchestrat: ${phrases.join(", ")}. Call get_attention and handle them. If your user asked you to stop, reply briefly and end your turn; Orchestrat will not block again for these items.`;
}

async function withBudget<T>(
  budgetMs: number,
  run: (signal: AbortSignal) => Promise<T>
) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Attention request timed out"));
        }, budgetMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function attentionClient(
  input: StopHookInput,
  parsed: ParsedStop,
  config: OrchestratConfig
) {
  const resolved = await resolveInvocation({
    api: input.api,
    cwd: parsed.cwd,
    home: input.home,
    integration: input.integration,
    read: async () => config,
    credentials: input.credentials
  });
  // Attention follows the branch the checkout works on.
  return (
    await clientForCheckout(
      new AgentApiClient({
        baseUrl: resolved.api!,
        token: resolved.credential!,
        fetch: input.fetch,
        sleep: async () => undefined
      }),
      parsed.cwd,
      input.home
    )
  ).client;
}

export async function decideStop(input: StopHookInput): Promise<StopDecision> {
  try {
    const parsed = parseStopPayload(input.integration, input.payload);
    if (!parsed) return { continue: false, why: "unrecognized payload" };
    if (!parsed.eligible)
      return { continue: false, why: "turn did not complete" };
    const config = await (input.read ?? (() => readConfig(input.home)))();
    if (!continuesOnStop(config, input.integration))
      return { continue: false, why: "not opted in" };
    const now = (input.now ?? Date.now)();
    const key = sessionKey(input.integration, parsed.external);
    const session = (await readStopState(input.home)).sessions[key];
    const client = await attentionClient(input, parsed, config);
    const response: WaitResponse = await withBudget(
      input.budgetMs ?? STOP_BUDGET_MS,
      (signal) =>
        client.attention.wait(
          {
            ...(session?.cursor ? { after: session.cursor } : {}),
            timeout_ms: 0,
            directed_only: true
          },
          signal
        )
    );
    // Without a cursor this is the session's first Stop: the level snapshot.
    const items = session?.cursor
      ? itemsFromEvents(response.events)
      : itemsFromSummary(response.attention);
    const seen = new Set(session?.seen ?? []);
    const fresh = items.filter((item) => !seen.has(item.key));
    const recent = (session?.blocks ?? []).filter(
      (time) => now - time < BLOCK_WINDOW_MS
    );
    if (!fresh.length) {
      await updateSession(input.home, key, now, (current) => ({
        ...current,
        cursor: response.cursor
      }));
      return {
        continue: false,
        why: parsed.active
          ? "no new items since the last block"
          : "nothing pending"
      };
    }
    if (recent.length >= MAX_BLOCKS) {
      // Keep the cursor so these items surface once the budget frees up.
      await updateSession(input.home, key, now, (current) => current);
      return { continue: false, why: "block budget exhausted" };
    }
    await updateSession(input.home, key, now, (current) => ({
      cursor: response.cursor,
      blocks: [...current.blocks, now],
      seen: [...current.seen, ...fresh.map((item) => item.key)],
      updated_at: now
    }));
    return { continue: true, reason: reasonTemplate(fresh) };
  } catch {
    return { continue: false, why: "failed open" };
  }
}

export type StopOutput = { exitCode: 0 | 2; stdout?: string; stderr?: string };

// Each harness's own continuation mechanism.
export function renderStopDecision(
  integration: ConfigurableIntegration,
  decision: StopDecision
): StopOutput {
  if (!decision.continue) return { exitCode: 0 };
  if (integration === "claude-code" || integration === "codex")
    return { exitCode: 2, stderr: `${decision.reason}\n` };
  if (integration === "cursor")
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ followup_message: decision.reason })}\n`
    };
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({ decision: "continue", reason: decision.reason })}\n`
  };
}

export async function clearRewakeLock(home: string, payload: unknown) {
  const external = externalSessionId("claude-code", payload);
  if (!external) return;
  await rm(rewakeLockPath(home, external), { force: true });
}

async function lockToken(path: string) {
  const text = await readPrivateState(path, 4096);
  try {
    return text ? (JSON.parse(text) as { token?: string }).token : undefined;
  } catch {
    return undefined;
  }
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

// Claude Code idle wake (`--rewake`): an async Stop hook that long-polls for
// directed events and exits 2 to wake the session. One watcher per session;
// a newer watcher rewrites the lock and the older one exits on its next check.
export async function watchForRewake(
  input: StopHookInput & {
    maxMs?: number;
    roundMs?: number;
    settleMs?: number;
    lockPollMs?: number;
  }
): Promise<StopDecision> {
  const parsed = parseStopPayload("claude-code", input.payload);
  if (!parsed) return { continue: false, why: "unrecognized payload" };
  let config: OrchestratConfig;
  let client: AgentApiClient;
  try {
    config = await (input.read ?? (() => readConfig(input.home)))();
    if (!rewakeEnabled(config)) return { continue: false, why: "not opted in" };
    client = await attentionClient(
      { ...input, integration: "claude-code" },
      parsed,
      config
    );
  } catch {
    return { continue: false, why: "failed open" };
  }
  const now = input.now ?? Date.now;
  const lock = rewakeLockPath(input.home, parsed.external);
  const token = randomUUID();
  const key = sessionKey("claude-code", parsed.external);
  const stop = new AbortController();
  const deadline = now() + (input.maxMs ?? WATCH_MAX_MS);
  let poller: NodeJS.Timeout | undefined;
  try {
    await writePrivateState(
      lock,
      `${JSON.stringify({ pid: process.pid, token, started_at: new Date(now()).toISOString() })}\n`
    );
    poller = setInterval(() => {
      void lockToken(lock).then((current) => {
        if (current !== token) stop.abort();
      });
    }, input.lockPollMs ?? 1000);
    // Let the synchronous Stop hook (2 s budget) record its cursor first.
    await delay(input.settleMs ?? STOP_BUDGET_MS + 500, stop.signal);
    let cursor = (await readStopState(input.home)).sessions[key]?.cursor;
    if (!cursor && !stop.signal.aborted)
      cursor = (
        await withBudget(STOP_BUDGET_MS * 5, (signal) =>
          client.attention.wait({ timeout_ms: 0, directed_only: true }, signal)
        )
      ).cursor;
    while (!stop.signal.aborted && now() < deadline) {
      const roundMs = Math.max(
        0,
        Math.floor(
          Math.min(
            input.roundMs ?? WAIT_ROUND_MS,
            WAIT_ROUND_MS,
            deadline - now()
          )
        )
      );
      const round = new AbortController();
      const onStop = () => round.abort();
      stop.signal.addEventListener("abort", onStop, { once: true });
      let response: WaitResponse;
      try {
        response = await withBudget(roundMs + 5000, (signal) => {
          signal.addEventListener("abort", () => round.abort(), { once: true });
          return client.attention.wait(
            { after: cursor, timeout_ms: roundMs, directed_only: true },
            round.signal
          );
        });
      } catch (error) {
        if (stop.signal.aborted) break;
        throw error;
      } finally {
        stop.signal.removeEventListener("abort", onStop);
      }
      if (stop.signal.aborted) break;
      cursor = response.cursor;
      const session = (await readStopState(input.home)).sessions[key];
      const seen = new Set(session?.seen ?? []);
      const fresh = itemsFromEvents(response.events).filter(
        (item) => !seen.has(item.key)
      );
      if (!fresh.length) continue;
      const at = now();
      const recent = (session?.blocks ?? []).filter(
        (time) => at - time < BLOCK_WINDOW_MS
      );
      if (recent.length >= MAX_BLOCKS) continue;
      if ((await lockToken(lock)) !== token) break;
      await updateSession(input.home, key, at, (current) => ({
        cursor: response.cursor,
        blocks: [...current.blocks, at],
        seen: [...current.seen, ...fresh.map((item) => item.key)],
        updated_at: at
      }));
      return { continue: true, reason: reasonTemplate(fresh) };
    }
    return {
      continue: false,
      why: stop.signal.aborted ? "superseded" : "timed out"
    };
  } catch {
    return { continue: false, why: "failed open" };
  } finally {
    clearInterval(poller);
    if ((await lockToken(lock)) === token) await rm(lock, { force: true });
  }
}
