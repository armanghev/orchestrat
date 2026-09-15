"use client";

import { Reveal } from "@/components/motion/reveal";

const steps = [
  {
    number: "01",
    title: "Connect",
    label: "MCP · hooks · API",
    detail: "An agent joins the workspace with presence."
  },
  {
    number: "02",
    title: "Claim",
    label: "Exclusive lease",
    detail: "Ownership becomes visible and enforceable."
  },
  {
    number: "03",
    title: "Publish",
    label: "Messages · documents",
    detail: "Context becomes durable shared knowledge."
  },
  {
    number: "04",
    title: "Review",
    label: "Human control",
    detail: "A person can approve, redirect, or stop."
  }
];

export function WorkflowSection() {
  return (
    <section id="workflow" className="line-b py-20 md:py-24">
      <div className="max-w-container-lg mx-auto px-6">
        <Reveal>
          <div className="max-w-xl space-y-3">
            <p className="font-mono text-[11px] tracking-[0.14em] text-primary-text uppercase">
              Ops sequence
            </p>
            <h2 className="text-2xl leading-tight font-semibold tracking-tight text-foreground sm:text-3xl">
              Connect → Claim → Publish → Review
            </h2>
            <p className="text-sm leading-relaxed font-light text-muted-foreground">
              A horizontal ops sequence — not a feature grid. Same shared state
              at every stage, without replacing the runtime that executes work.
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.1} yOffset={14}>
          <div className="mt-12 overflow-hidden rounded-lg border border-border">
            <div className="flex items-center justify-between border-b border-border bg-surface-raised px-5 py-3 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
              <span>Shared coordination plane</span>
              <span className="hidden sm:inline">project / northstar</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4">
              {steps.map((step, index) => (
                <article
                  key={step.number}
                  className={`relative bg-card px-5 py-6 ${
                    index < steps.length - 1
                      ? "border-b border-border md:border-r md:border-b-0"
                      : ""
                  }`}
                >
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-[11px] text-primary-text">
                      {step.number}
                    </span>
                    <h3 className="text-sm font-medium text-foreground">
                      {step.title}
                    </h3>
                  </div>
                  <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                    {step.label}
                  </p>
                  <p className="mt-3 text-xs leading-relaxed font-light text-muted-foreground">
                    {step.detail}
                  </p>
                  {index < steps.length - 1 && (
                    <span
                      className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 font-mono text-muted-foreground/50 md:block"
                      aria-hidden
                    >
                      →
                    </span>
                  )}
                </article>
              ))}
            </div>

            <div className="grid grid-cols-1 border-t border-border bg-rail font-mono text-[10px] text-muted-foreground sm:grid-cols-3">
              <span className="border-b border-border px-5 py-3 sm:border-r sm:border-b-0">
                ● task state stays current
              </span>
              <span className="border-b border-border px-5 py-3 sm:border-r sm:border-b-0">
                ● decisions survive sessions
              </span>
              <span className="px-5 py-3">● authority stays human</span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
