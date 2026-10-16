import type { ServerContext } from "@modelcontextprotocol/server";
import type { WaitResponse } from "@orchestrat/protocol";
import { z } from "zod";
import type { AttentionToolHost } from "./attention-tools.js";

// One server long-poll is at most 25 s; the tool loops rounds until something
// happens or its budget is spent.
const roundMs = 25_000;
const requestLimitSeconds = 1800;
// A setup-written client timeout (--wait-budget-seconds) is capped here.
const configuredCapSeconds = 600;

export type WaitBudget = { defaultSeconds: number; maxSeconds: number };

// Per-integration budgets. Without a setup-written client timeout, codex and
// antigravity stay at their default, which is what their clients are known to
// allow; progress does not extend those timeouts.
export function waitBudget(
  integration: string,
  waitBudgetSeconds?: number
): WaitBudget {
  const configured =
    waitBudgetSeconds !== undefined && waitBudgetSeconds > 0
      ? Math.min(Math.floor(waitBudgetSeconds), configuredCapSeconds)
      : undefined;
  switch (integration) {
    case "claude-code":
      return { defaultSeconds: 110, maxSeconds: 1800 };
    case "codex":
      return { defaultSeconds: configured ?? 50, maxSeconds: configured ?? 50 };
    case "antigravity":
      return {
        defaultSeconds: configured ?? 150,
        maxSeconds: configured ?? 150
      };
    case "opencode":
      return { defaultSeconds: 600, maxSeconds: 1800 };
    default:
      return { defaultSeconds: 50, maxSeconds: 50 };
  }
}

type WaitInput = {
  cursor?: string;
  max_wait_seconds?: number;
  directed_only?: boolean;
};
type WaitResult =
  | (Pick<WaitResponse, "events" | "cursor" | "attention"> & {
      status: "updates" | "pending";
    })
  | {
      status: "no_updates";
      waited_seconds: number;
      cursor: string;
      next_step: string;
    };

async function waitForUpdate(
  host: AttentionToolHost,
  input: WaitInput,
  request: ServerContext["mcpReq"],
  budgetSeconds: number,
  now: () => number
): Promise<WaitResult> {
  const started = now();
  const budgetMs = budgetSeconds * 1000;
  const progressToken = request._meta?.progressToken;
  let cursor = input.cursor;
  let reported = 0;
  for (;;) {
    const remaining = budgetMs - (now() - started);
    const response = await host.client().attention.wait(
      {
        ...(cursor === undefined ? {} : { after: cursor }),
        timeout_ms: Math.max(0, Math.min(roundMs, remaining)),
        directed_only: input.directed_only ?? false
      },
      request.signal
    );
    cursor = response.cursor;
    if (response.status !== "timeout")
      return {
        status: response.status,
        events: response.events,
        cursor: response.cursor,
        attention: response.attention
      };
    const elapsed = now() - started;
    if (elapsed >= budgetMs || request.signal.aborted) {
      const waited = Math.round(elapsed / 1000);
      return {
        status: "no_updates",
        waited_seconds: waited,
        cursor: response.cursor,
        next_step: `Nothing happened in ${waited}s. Call wait_for_update again with this cursor, or end your turn; Orchestrat hooks (if installed) will surface new work.`
      };
    }
    // Progress resets idle timers in clients that honour it (Claude Code,
    // OpenCode); it is only sent when the client asked for it, and it must
    // increase between notifications.
    const progress = Math.round(elapsed / 100) / 10;
    if (progressToken !== undefined && progress > reported) {
      reported = progress;
      await request
        .notify({
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            total: budgetSeconds,
            message: `Waiting for updates (${Math.round(progress)}s of ${budgetSeconds}s)`
          }
        })
        .catch(() => undefined);
    }
  }
}

// wait_for_update (ORC-11). `now` is injectable for tests.
export function registerWaitTool(
  host: AttentionToolHost,
  options: { now?: () => number } = {}
): void {
  const now = options.now ?? Date.now;
  const budget = waitBudget(host.integration, host.waitBudgetSeconds);
  host.server.registerTool(
    "wait_for_update",
    {
      description: `Call this instead of ending your turn when you are blocked or waiting on another agent. Returns as soon as something relevant happens: a direct message, a mention, a handoff, a comment, status change or released claim on a watched task, or a resolved blocker. Returns status "pending" at once when directed items are already waiting (read them with get_attention). Waits ${budget.defaultSeconds}s by default; max_wait_seconds may raise that to ${budget.maxSeconds}s here. Pass the returned cursor to the next call so nothing is missed. directed_only ignores activity that is not addressed to you.`,
      inputSchema: {
        cursor: z
          .string()
          .regex(/^[0-9]{1,19}$/)
          .optional(),
        max_wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(requestLimitSeconds)
          .optional(),
        directed_only: z.boolean().optional()
      }
    },
    async (input, ctx) =>
      // The wait result already carries the attention summary.
      host.call(
        () =>
          waitForUpdate(
            host,
            input,
            ctx.mcpReq,
            Math.min(
              input.max_wait_seconds ?? budget.defaultSeconds,
              budget.maxSeconds
            ),
            now
          ),
        { notifyInbox: false }
      )
  );
}
