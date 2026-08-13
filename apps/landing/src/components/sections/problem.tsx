"use client";

import React from "react";
import { AlertCircle, Zap, ShieldAlert, Ghost } from "lucide-react";
import { Reveal, RevealStagger, RevealItem } from "@/components/motion/reveal";

export function ProblemSection() {
  const problems = [
    {
      icon: Zap,
      title: "Duplicate work",
      description:
        "Without atomic claims, two agents can start the same task before either sees the other."
    },
    {
      icon: Ghost,
      title: "Stale ownership",
      description:
        "When a process stops reporting heartbeats, work can remain locked with no clear owner."
    },
    {
      icon: AlertCircle,
      title: "Context lost between sessions",
      description:
        "Decisions, messages, and project knowledge disappear inside isolated model sessions."
    },
    {
      icon: ShieldAlert,
      title: "Invisible agent activity",
      description:
        "Humans cannot review, redirect, or stop work they cannot see in a shared activity history."
    }
  ];

  return (
    <section
      id="problem"
      className="line-b relative overflow-hidden py-24 md:py-32"
    >
      <div className="max-w-container-lg relative z-10 mx-auto px-6">
        <Reveal>
          <div className="mx-auto mb-16 max-w-2xl space-y-3 text-center">
            <h2 className="text-2xl leading-tight font-semibold tracking-[-0.03em] text-zinc-50 sm:text-3xl">
              Running agents is easy. Coordinating them is hard.
            </h2>
            <p className="text-sm leading-relaxed font-light text-zinc-500">
              Separate agent sessions hide ownership, decisions, and progress.
              orchestrat turns that invisible work into durable shared project
              state.
            </p>
          </div>
        </Reveal>

        <RevealStagger
          className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4"
          staggerDelay={0.06}
        >
          {problems.map((p, i) => {
            const Icon = p.icon;
            return (
              <RevealItem key={i}>
                <div className="group flex h-full flex-col justify-between space-y-4 rounded-xl border border-white/5 bg-zinc-900/30 p-5 transition-all duration-300 hover:border-white/9">
                  <div className="space-y-4">
                    <div className="w-fit rounded-lg border border-white/5 bg-zinc-950 p-2 text-zinc-500 transition-colors group-hover:text-zinc-400">
                      <Icon className="h-4 w-4" strokeWidth={1.5} />
                    </div>
                    <div className="space-y-1.5">
                      <h3 className="text-sm font-medium text-zinc-200">
                        {p.title}
                      </h3>
                      <p className="text-xs leading-relaxed font-light text-zinc-500">
                        {p.description}
                      </p>
                    </div>
                  </div>
                </div>
              </RevealItem>
            );
          })}
        </RevealStagger>
      </div>
    </section>
  );
}
