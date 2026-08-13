"use client";

import {
  CloudCheck,
  GitPullRequest,
  ShieldCheck,
  Terminal
} from "lucide-react";
import { Reveal } from "@/components/motion/reveal";

const steps = [
  {
    icon: Terminal,
    number: "01",
    title: "Connect",
    label: "MCP, hooks, or API",
    detail: "An agent joins the workspace."
  },
  {
    icon: GitPullRequest,
    number: "02",
    title: "Claim",
    label: "Exclusive task lease",
    detail: "Ownership becomes visible."
  },
  {
    icon: CloudCheck,
    number: "03",
    title: "Publish",
    label: "Messages and documents",
    detail: "Context becomes durable."
  },
  {
    icon: ShieldCheck,
    number: "04",
    title: "Review",
    label: "Human control point",
    detail: "A person can intervene."
  }
];

export function WorkflowSection() {
  return (
    <section id="workflow" className="line-b py-24 md:py-32">
      <div className="max-w-container-lg mx-auto px-6">
        <Reveal>
          <div className="max-w-xl space-y-3">
            <h2 className="text-2xl leading-tight font-semibold tracking-tight text-zinc-100 sm:text-3xl">
              Coordination at every stage of the work.
            </h2>
            <p className="text-sm leading-relaxed font-light text-zinc-500">
              Orchestrat gives every participant the same project state without
              replacing the runtime that executes the work.
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.1} yOffset={16}>
          <div className="mt-16 overflow-hidden border-y border-white/6 py-8 md:py-12">
            <div className="mb-10 flex items-center justify-between font-mono text-[10px] tracking-[0.18em] text-zinc-700 uppercase">
              <span>Shared coordination plane</span>
              <span className="hidden sm:block">project / northstar</span>
            </div>

            <div className="relative grid gap-y-12 md:grid-cols-4 md:gap-x-8 md:gap-y-0">
              <div className="absolute top-5 right-[12.5%] left-[12.5%] hidden h-px bg-gradient-to-r from-transparent via-zinc-600 to-transparent md:block" />

              {steps.map((step) => {
                const Icon = step.icon;
                return (
                  <article
                    key={step.number}
                    className="relative grid grid-cols-[40px_1fr] gap-x-4 md:block"
                  >
                    <div className="relative z-10 flex h-10 w-10 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950 text-zinc-400 md:mx-auto">
                      <Icon className="h-4 w-4" strokeWidth={1.5} />
                    </div>

                    <div className="min-w-0 md:mt-7 md:text-center">
                      <div className="flex items-baseline gap-3 md:justify-center">
                        <span className="font-mono text-[10px] text-zinc-700">
                          {step.number}
                        </span>
                        <h3 className="text-sm font-medium text-zinc-200">
                          {step.title}
                        </h3>
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-zinc-600">
                        {step.label}
                      </p>
                      <p className="mt-3 text-xs leading-relaxed font-light text-zinc-500">
                        {step.detail}
                      </p>
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="mt-12 grid grid-cols-1 border-t border-white/6 pt-5 font-mono text-[10px] text-zinc-600 sm:grid-cols-3 sm:gap-6">
              <span className="py-2 sm:py-0">● task state stays current</span>
              <span className="py-2 sm:border-x sm:border-white/6 sm:px-6 sm:py-0">
                ● decisions survive sessions
              </span>
              <span className="py-2 text-left sm:py-0 sm:text-right">
                ● authority stays human
              </span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
