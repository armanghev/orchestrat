import type { Database } from "@orchestrat/db";
import type {
  RealtimeEventEnvelope,
  WaitEvent,
  WaitQuery,
  WaitResponse
} from "@orchestrat/protocol";
import type { AgentPrincipal } from "./agent-service.js";
import { ApiError } from "./api-error.js";
import {
  attentionEventTypes,
  classifyEventsSince
} from "./attention-events.js";
import type { AttentionService } from "./attention-service.js";

// Spec §10 and §15. Limits are server constants (§19.5).
export const waitLimitPerAgent = 3;
export const waitLimitPerProject = 50;
const waitEventLimit = 50;
const debounceMs = 250;
const recheckMs = 5_000;

type Waiter = {
  agentId: string;
  projectId: string;
  since: Date;
  // Set by notify(); cleared before each classification so an event that
  // lands mid-query still triggers another pass.
  dirty: boolean;
  wake?: () => void;
};
type Outcome = {
  status: WaitResponse["status"];
  events: WaitEvent[];
  cursor: string;
};

// In-memory long-poll waiters (spec §10). The realtime publisher calls
// notify() after commit; a woken waiter re-classifies after a 250 ms
// debounce, with a 5 s fallback re-check for writes this process never
// published. No DB connection is held while a waiter sleeps.
export class AttentionWaitHub {
  private readonly waiters = new Map<string, Set<Waiter>>();
  private closing = false;

  constructor(
    protected readonly attention: AttentionService,
    protected readonly db: Database
  ) {}

  notify(envelope: RealtimeEventEnvelope): void {
    const waiters = this.waiters.get(envelope.project_id);
    if (!waiters || !attentionEventTypes.has(envelope.event_type)) return;
    for (const waiter of waiters) {
      // An agent's own actions never classify for it.
      if (
        envelope.actor?.type === "agent" &&
        envelope.actor.id === waiter.agentId
      )
        continue;
      waiter.dirty = true;
      waiter.wake?.();
    }
  }

  async wait(
    principal: AgentPrincipal,
    query: WaitQuery,
    signal: AbortSignal
  ): Promise<WaitResponse> {
    const after = query.after === undefined ? undefined : Number(query.after);
    if (after !== undefined && !Number.isSafeInteger(after))
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "The wait cursor is invalid."
      );
    const waiter = this.register(principal);
    let outcome: Outcome | WaitResponse;
    try {
      outcome = await this.poll(principal, query, after, waiter, signal);
    } finally {
      this.unregister(waiter);
    }
    if ("attention" in outcome) return outcome;
    return {
      ...outcome,
      attention: await this.attention.summaryAgent(principal, {
        branchId: query.branch_id
      })
    };
  }

  // Earliest active wait per agent, for the dashboard's "Waiting for updates".
  waitingSince(projectId: string): Map<string, Date> {
    const since = new Map<string, Date>();
    for (const waiter of this.waiters.get(projectId) ?? []) {
      const current = since.get(waiter.agentId);
      if (!current || waiter.since < current)
        since.set(waiter.agentId, waiter.since);
    }
    return since;
  }

  // Ends every active wait with its current result. The wait routes call it
  // before the server closes, so long polls never hold up a shutdown.
  close(): void {
    this.closing = true;
    for (const waiters of this.waiters.values())
      for (const waiter of waiters) waiter.wake?.();
  }

  private register(principal: AgentPrincipal): Waiter {
    const waiters = this.waiters.get(principal.projectId) ?? new Set<Waiter>();
    let forAgent = 0;
    for (const waiter of waiters)
      if (waiter.agentId === principal.agentId) forAgent += 1;
    const limit =
      forAgent >= waitLimitPerAgent
        ? { limit: waitLimitPerAgent, scope: "An agent" }
        : waiters.size >= waitLimitPerProject
          ? { limit: waitLimitPerProject, scope: "A project" }
          : null;
    if (limit)
      throw new ApiError(
        429,
        "WAIT_LIMIT",
        `${limit.scope} can hold at most ${limit.limit} concurrent waits.`,
        { limit: limit.limit }
      );
    const waiter: Waiter = {
      agentId: principal.agentId,
      projectId: principal.projectId,
      since: new Date(),
      dirty: false
    };
    waiters.add(waiter);
    this.waiters.set(principal.projectId, waiters);
    return waiter;
  }

  private unregister(waiter: Waiter) {
    const waiters = this.waiters.get(waiter.projectId);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.waiters.delete(waiter.projectId);
  }

  private async poll(
    principal: AgentPrincipal,
    query: WaitQuery,
    after: number | undefined,
    waiter: Waiter,
    signal: AbortSignal
  ): Promise<Outcome | WaitResponse> {
    let cursor: string;
    if (after === undefined) {
      // Level-triggered: pending directed items return at once. Otherwise the
      // wait starts from the summary cursor, which is read before the rest of
      // the summary, so nothing committed in between is missed.
      const attention = await this.attention.summaryAgent(principal, {
        branchId: query.branch_id
      });
      if (await this.attention.hasDirectedPending(attention))
        return {
          status: "pending",
          events: [],
          cursor: attention.cursor,
          attention
        };
      cursor = attention.cursor;
    } else {
      cursor = String(after);
    }
    const deadline = Date.now() + query.timeout_ms;
    const options = {
      directedOnly: query.directed_only,
      kinds: query.kinds,
      limit: waitEventLimit,
      branchId: await this.attention.agentBranchId(principal, query.branch_id)
    };
    for (;;) {
      waiter.dirty = false;
      const result = await classifyEventsSince(
        this.db,
        principal,
        Number(cursor),
        options
      );
      cursor = result.cursor;
      if (result.events.length > 0)
        return { status: "updates", events: result.events, cursor };
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal.aborted || this.closing) break;
      if (result.more) continue;
      await this.sleep(waiter, Math.min(remaining, recheckMs), signal);
      if (signal.aborted || this.closing) break;
    }
    return { status: "timeout", events: [], cursor };
  }

  // Resolves on the fallback timer, a debounced notify(), abort or close.
  private sleep(waiter: Waiter, ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      let debounce: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        clearTimeout(debounce);
        signal.removeEventListener("abort", done);
        waiter.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      waiter.wake = () => {
        if (this.closing) return done();
        debounce ??= setTimeout(done, debounceMs);
      };
      if (signal.aborted || this.closing) done();
      else if (waiter.dirty) waiter.wake();
    });
  }
}
