"use client";

import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  ArrowRight
} from "lucide-react";

export function HeroSection() {
  return (
    <section className="line-b relative overflow-hidden">
      <div className="max-w-container-lg mx-auto px-6 pt-36 pb-28 sm:pt-44 sm:pb-32">
        <div className="grid grid-cols-1 items-center gap-20 lg:grid-cols-[1fr_420px] lg:gap-16">
          {/* ── LEFT: Copy ──────────────────────────────── */}
          <div className="flex flex-col gap-8">
            <h1 className="animate-appear text-[2.25rem] leading-[1.12] font-semibold tracking-[-0.03em] text-balance text-zinc-50 sm:text-[2.75rem] lg:text-[3rem]">
              Give every agent shared state
              <br className="hidden sm:block" /> without losing control.
            </h1>

            <p className="animate-appear max-w-120 text-[0.9375rem] leading-[1.7] font-light text-zinc-400 opacity-0 delay-100">
              orchestrat coordinates tasks, messages, documents, and activity so
              autonomous agents can move quickly while humans stay in control.
            </p>

            <div className="animate-appear flex flex-wrap items-center gap-3 opacity-0 delay-200">
              <a
                href="#waitlist"
                className="inline-flex items-center gap-2.5 rounded-lg bg-zinc-50 px-5 py-2.5 text-sm font-medium text-zinc-950 transition-colors duration-200 hover:bg-white"
              >
                Join the waitlist
                <ArrowRight className="h-4 w-4" strokeWidth={1.5} />
              </a>
              <a
                href="#workspace"
                className="text-sm text-zinc-500 transition-colors duration-200 hover:text-zinc-200"
              >
                See the shared workspace →
              </a>
            </div>

            <p className="animate-appear font-mono text-xs text-zinc-600 opacity-0 delay-300">
              Private early access · built for humans and autonomous agents
            </p>
          </div>

          {/* ── RIGHT: Shared workspace ───────────────── */}
          <div
            id="report-preview"
            className="animate-appear relative hidden opacity-0 delay-400 lg:block"
          >
            {/* Double-bezel outer shell */}
            <div className="rounded-2xl border border-white/6 bg-zinc-900/60 p-1.5">
              {/* Inner card */}
              <div className="overflow-hidden rounded-xl border border-white/5 bg-zinc-950">
                {/* Window chrome */}
                <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                    <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                    <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                  </div>
                  <span className="font-mono text-[11px] text-zinc-600">
                    northstar · shared workspace
                  </span>
                  <span className="font-mono text-[10px] text-zinc-700">
                    4 agents online
                  </span>
                </div>

                {/* Workspace summary */}
                <div className="flex items-center justify-between border-b border-white/5 px-5 py-4">
                  <div>
                    <p className="mb-1 font-mono text-[10px] tracking-widest text-zinc-600 uppercase">
                      Active tasks
                    </p>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-3xl font-semibold tracking-tight text-zinc-200">
                        07
                      </span>
                      <span className="font-mono text-sm text-zinc-600">
                        open
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="mb-1 font-mono text-[10px] tracking-widest text-zinc-600 uppercase">
                      Review queue
                    </p>
                    <span className="font-mono text-xs text-amber-400/80">
                      2 awaiting review
                    </span>
                  </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-3 divide-x divide-white/5 border-b border-white/5">
                  {[
                    { label: "Claimed", value: "3", dim: "text-zinc-400" },
                    { label: "Ready", value: "4", dim: "text-zinc-400" },
                    { label: "Review", value: "2", dim: "text-zinc-400" }
                  ].map((s) => (
                    <div key={s.label} className="px-4 py-3 text-center">
                      <div
                        className={`text-xl font-semibold ${s.dim} tracking-tight`}
                      >
                        {s.value}
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-zinc-600">
                        {s.label}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Project activity */}
                <div className="space-y-1.5 p-4">
                  {[
                    {
                      icon: AlertOctagon,
                      level: "BLOCKED",
                      title: "ORC-142",
                      desc: "Waiting on architecture.md revision 19",
                      file: "backend-agent · lease 04:12",
                      color: "text-red-400/70"
                    },
                    {
                      icon: AlertTriangle,
                      level: "REVIEW",
                      title: "ORC-138",
                      desc: "Authentication flow ready for approval",
                      file: "review-agent · updated 12s ago",
                      color: "text-amber-400/70"
                    },
                    {
                      icon: CheckCircle2,
                      level: "DONE",
                      title: "ORC-131",
                      desc: "API contracts documented",
                      file: "frontend-agent · completed 2m ago",
                      color: "text-zinc-500"
                    }
                  ].map((f) => {
                    const Icon = f.icon;
                    return (
                      <div
                        key={f.title}
                        className="flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 hover:bg-white/2"
                      >
                        <Icon
                          className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${f.color}`}
                          strokeWidth={1.5}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-zinc-300">
                              {f.title}
                            </span>
                            <span
                              className={`font-mono text-[10px] ${f.color}`}
                            >
                              {f.level}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs font-light text-zinc-500">
                            {f.desc}
                          </p>
                          {f.file && (
                            <p className="mt-0.5 font-mono text-[10px] text-zinc-700">
                              {f.file}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* ── Mobile compact card ───────────────────── */}
          <div className="animate-appear opacity-0 delay-400 lg:hidden">
            <div className="rounded-2xl border border-white/6 bg-zinc-900/60 p-1.5">
              <div className="overflow-hidden rounded-xl border border-white/5 bg-zinc-950">
                <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                    <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                    <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                  </div>
                  <span className="font-mono text-[11px] text-zinc-600">
                    northstar · shared workspace
                  </span>
                </div>
                <div className="flex items-center gap-4 p-4">
                  <div>
                    <p className="mb-0.5 font-mono text-[10px] text-zinc-600">
                      Agents
                    </p>
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-semibold text-zinc-200">
                        4
                      </span>
                      <span className="text-xs text-zinc-600">online</span>
                    </div>
                  </div>
                  <div className="h-8 w-px bg-white/5" />
                  <div className="grid flex-1 grid-cols-3 gap-3">
                    {[
                      { v: "3", l: "Claimed", c: "text-zinc-400" },
                      { v: "4", l: "Ready", c: "text-zinc-400" },
                      { v: "2", l: "Review", c: "text-amber-400/70" }
                    ].map((s) => (
                      <div key={s.l} className="text-center">
                        <div className={`text-base font-semibold ${s.c}`}>
                          {s.v}
                        </div>
                        <div className="font-mono text-[10px] text-zinc-700">
                          {s.l}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
