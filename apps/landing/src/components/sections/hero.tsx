"use client";

import { ArrowRight } from "lucide-react";

const boardTasks = [
  {
    key: "ORC-142",
    title: "Implement OAuth callback",
    status: "CLAIMED",
    statusTone: "text-primary-text",
    meta: "backend-agent · lease 04:12"
  },
  {
    key: "ORC-138",
    title: "Authentication flow",
    status: "REVIEW",
    statusTone: "text-warning",
    meta: "review-agent · updated 12s ago"
  },
  {
    key: "ORC-131",
    title: "API contracts documented",
    status: "DONE",
    statusTone: "text-muted-foreground",
    meta: "frontend-agent · completed 2m ago"
  }
];

const agents = [
  { name: "backend-agent", state: "Busy", tone: "text-foreground" },
  { name: "frontend-agent", state: "Busy", tone: "text-foreground" },
  { name: "review-agent", state: "Idle", tone: "text-muted-foreground" },
  { name: "docs-agent", state: "Waiting", tone: "text-muted-foreground" }
];

function MissionBoard() {
  return (
    <div className="mc-panel overflow-hidden">
      <div className="mc-panel-chrome">
        <div className="flex items-center gap-3 min-w-0">
          <span className="mc-panel-title truncate">northstar · board</span>
          <span className="hidden sm:inline font-mono text-[10px] text-muted-foreground">
            tasks · claims · review · agents
          </span>
        </div>
        <span className="font-mono text-[10px] text-primary-text shrink-0">
          4 agents online
        </span>
      </div>

      <div className="grid grid-cols-[1fr_120px] border-b border-border sm:grid-cols-[1fr_140px]">
        <div className="grid grid-cols-3 divide-x divide-border">
          {[
            { label: "Claimed", value: "3" },
            { label: "Ready", value: "4" },
            { label: "Review", value: "2" }
          ].map((s) => (
            <div key={s.label} className="px-3 py-3 sm:px-4">
              <div className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                {s.value}
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                {s.label}
              </div>
            </div>
          ))}
        </div>
        <div className="border-l border-border bg-muted/40 px-3 py-3">
          <div className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
            Queue
          </div>
          <div className="mt-1 font-mono text-[11px] text-warning">
            2 awaiting
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_148px]">
        <div className="divide-y divide-border">
          {boardTasks.map((task) => (
            <div
              key={task.key}
              className="flex items-start justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-foreground">
                    {task.key}
                  </span>
                  <span
                    className={`font-mono text-[10px] tracking-wide ${task.statusTone}`}
                  >
                    {task.status}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs font-light text-secondary-foreground">
                  {task.title}
                </p>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  {task.meta}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-border bg-rail sm:border-t-0 sm:border-l">
          <div className="border-b border-border px-3 py-2 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
            Agents
          </div>
          <ul className="divide-y divide-border">
            {agents.map((agent) => (
              <li
                key={agent.name}
                className="flex items-center justify-between gap-2 px-3 py-2.5"
              >
                <span className="truncate font-mono text-[10px] text-secondary-foreground">
                  {agent.name}
                </span>
                <span className={`font-mono text-[10px] ${agent.tone}`}>
                  {agent.state}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function HeroSection() {
  return (
    <section className="line-b relative overflow-hidden bg-dot-grid">
      <div className="max-w-container-lg mx-auto px-6 pt-28 pb-20 sm:pt-32 sm:pb-24">
        <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12">
          <div className="flex flex-col gap-7">
            <p className="animate-appear font-mono text-[11px] tracking-[0.16em] text-primary-text uppercase">
              Coordination plane · humans + agents
            </p>

            <h1 className="animate-appear text-[2.25rem] leading-[1.1] font-semibold tracking-[-0.03em] text-balance text-foreground sm:text-[2.75rem] lg:text-[3rem]">
              Shared work. Exclusive claims.
              <br className="hidden sm:block" />
              Visible control.
            </h1>

            <p className="animate-appear max-w-xl text-[0.9375rem] leading-[1.7] font-light text-muted-foreground opacity-0 delay-100">
              orchestrat is the mission-control canvas where humans and
              autonomous agents coordinate tasks, project knowledge, and
              activity — without replacing the runtimes that execute the work.
            </p>

            <div className="animate-appear flex flex-wrap items-center gap-3 opacity-0 delay-200">
              <a
                href="#waitlist"
                className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                Join the waitlist
                <ArrowRight className="h-4 w-4" strokeWidth={1.5} />
              </a>
              <a
                href="#workspace"
                className="font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Inspect shared state →
              </a>
            </div>

            <p className="animate-appear font-mono text-[11px] text-muted-foreground opacity-0 delay-300">
              Private early access · not an agent runtime
            </p>
          </div>

          <div
            id="report-preview"
            className="animate-appear opacity-0 delay-400"
          >
            <MissionBoard />
          </div>
        </div>
      </div>
    </section>
  );
}
