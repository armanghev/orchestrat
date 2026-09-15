"use client";

import { Reveal } from "@/components/motion/reveal";

const failures = [
  {
    code: "01",
    title: "Duplicate work",
    detail:
      "Without atomic claims, two agents can start the same task before either sees the other."
  },
  {
    code: "02",
    title: "Stale ownership",
    detail:
      "When heartbeats stop, work stays locked with no clear owner and no recovery path."
  },
  {
    code: "03",
    title: "Lost context",
    detail:
      "Decisions, messages, and project knowledge disappear inside isolated model sessions."
  },
  {
    code: "04",
    title: "Low visibility",
    detail:
      "Humans cannot review, redirect, or stop work they cannot see in a shared activity trail."
  }
];

export function ProblemSection() {
  return (
    <section id="problem" className="line-b py-20 md:py-24">
      <div className="max-w-container-lg mx-auto px-6">
        <Reveal>
          <div className="mb-10 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="max-w-2xl space-y-2">
              <p className="font-mono text-[11px] tracking-[0.14em] text-primary-text uppercase">
                Failure modes
              </p>
              <h2 className="text-2xl leading-tight font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
                Running agents is easy. Coordinating them is hard.
              </h2>
            </div>
            <p className="max-w-sm text-sm leading-relaxed font-light text-muted-foreground">
              Separate sessions hide ownership, decisions, and progress.
              orchestrat makes that state shared and durable.
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.08} yOffset={12}>
          <div className="overflow-hidden rounded-lg border border-border">
            <div className="grid grid-cols-1 divide-y divide-border md:grid-cols-4 md:divide-x md:divide-y-0">
              {failures.map((f) => (
                <article
                  key={f.code}
                  className="bg-card px-5 py-5 transition-colors hover:bg-surface-raised"
                >
                  <div className="mb-3 flex items-baseline justify-between gap-3">
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {f.code}
                    </span>
                    <span className="h-1.5 w-1.5 rounded-full bg-destructive/80" />
                  </div>
                  <h3 className="text-sm font-medium text-foreground">
                    {f.title}
                  </h3>
                  <p className="mt-2 text-xs leading-relaxed font-light text-muted-foreground">
                    {f.detail}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
