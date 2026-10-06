"use client";

import { RotateCcw } from "lucide-react";
import {
  AgentMark,
  Eyebrow,
  agents,
  delay,
  type AgentId
} from "@/components/landing/agents";
import { useSequence } from "@/components/landing/use-sequence";

const tasks: { key: string; title: string; agent: AgentId }[] = [
  { key: "ORC-201", title: "Migrate the invoices table", agent: "codex" },
  { key: "ORC-202", title: "Retry failed webhooks", agent: "claude" },
  { key: "ORC-203", title: "Billing settings screen", agent: "cursor" },
  { key: "ORC-204", title: "Update billing.md", agent: "antigravity" }
];
// 0 prompt · 1 tree · 2 tasks created · 3–6 claims · 7 summary
const durations = [900, 800, 1100, 650, 650, 650, 900, 1];
const CLAIM_START = 3;

export function FanOutSection() {
  const { ref, step, done, restart, reduced } = useSequence<HTMLDivElement>(
    durations,
    { loop: false, threshold: 0.4 }
  );

  return (
    <section
      id="how-it-works"
      aria-labelledby="fan-out-heading"
      className="site-container section-space"
    >
      <div className="section-head">
        <Eyebrow>How it works</Eyebrow>
        <h2 id="fan-out-heading" className="section-title">
          One plan in.
          <br />
          <span className="text-muted-foreground">
            Every agent knows what’s free.
          </span>
        </h2>
        <p className="section-copy">
          Ask one agent to break the work into tasks. Every agent you start on
          the project can see what’s ready, claim a task, and get going. No task
          is claimed twice.
        </p>
      </div>

      <div
        ref={ref}
        className="relative mx-auto max-w-6xl rounded-2xl border bg-card/30 px-4 pt-10 pb-8 sm:px-8 lg:px-10"
      >
        <div className="mx-auto flex max-w-xl items-start gap-3 rounded-xl border bg-card px-4 py-3.5 shadow-lg shadow-black/10">
          <AgentMark agent="you" className="mt-0.5 size-7 text-[10px]" />
          <div className="min-w-0 text-left">
            <p className="font-mono text-[11px] text-muted-foreground">
              You, to Claude Code
            </p>
            <p className="mt-1 text-[15px] leading-snug">
              Break the billing rewrite into tasks for the team.
            </p>
          </div>
        </div>

        <div aria-hidden="true" className="relative hidden lg:block">
          <div className="tree-stub" data-on={step >= 1} />
          {/* Rail ends sit on the first and last card centers (gap-4). */}
          <div
            className="tree-rail top-auto bottom-0"
            style={{
              left: "calc((100% - 3rem) / 8)",
              right: "calc((100% - 3rem) / 8)"
            }}
            data-on={step >= 1}
          />
        </div>

        <ol className="mt-8 grid gap-3 sm:grid-cols-2 lg:mt-0 lg:grid-cols-4 lg:gap-4">
          {tasks.map((task, index) => {
            const claimed = step >= CLAIM_START + index;
            return (
              <li key={task.key} className="flex flex-col">
                <div
                  aria-hidden="true"
                  className="tree-stub hidden lg:block"
                  data-on={step >= 1}
                  style={delay(index, 60)}
                />
                <div
                  className="seq rounded-xl border bg-rail p-4 text-left"
                  data-on={step >= 2}
                  style={delay(index, 110)}
                >
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {task.key}
                  </p>
                  <p className="mt-1.5 text-sm font-medium">{task.title}</p>
                  <div className="mt-4 flex h-7 items-center">
                    {claimed ? (
                      <span
                        key="claimed"
                        className="enter flex items-center gap-2 text-xs"
                      >
                        <AgentMark
                          agent={task.agent}
                          className="size-5 text-[8px]"
                        />
                        Claimed by {agents[task.agent].name}
                      </span>
                    ) : (
                      <span className="status bg-info/10 text-info">Ready</span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-8 flex min-h-10 flex-col items-center justify-center gap-3 text-center">
          <p
            className="seq seq-fade text-sm text-muted-foreground"
            data-on={step >= CLAIM_START}
          >
            You start each agent on the project. It finds a ready task and
            claims it.
          </p>
          <p
            className="seq seq-fade font-mono text-xs text-muted-foreground"
            data-on={step >= durations.length - 1}
          >
            4 tasks · 4 owners · 0 double claims
          </p>
          {done && !reduced && (
            <button
              type="button"
              onClick={restart}
              className="enter chip min-h-9 px-3 transition-colors hover:text-foreground"
            >
              <RotateCcw size={12} aria-hidden="true" />
              Replay
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
