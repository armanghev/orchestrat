"use client";

import { ArrowRight } from "lucide-react";

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
            <div className="mc-panel overflow-hidden">
              <div className="mc-panel-chrome">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="mc-panel-title truncate">
                    acme · alpha · overview
                  </span>
                  <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">
                    tasks · claims · review · agents
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-primary-text">
                  live mission control
                </span>
              </div>
              <div className="relative aspect-[1280/800] overflow-hidden bg-rail">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/images/dashboard-hero.png"
                  alt="Orchestrat dashboard overview showing Acme/Alpha with online agents, active claims, review queue, and recent activity"
                  className="h-full w-full object-cover object-top"
                  width={1280}
                  height={800}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
