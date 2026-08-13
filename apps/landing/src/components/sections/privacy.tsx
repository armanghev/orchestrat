"use client";

import React from "react";
import { Lock, EyeOff, Cpu, HardDrive } from "lucide-react";
import { Reveal, RevealStagger, RevealItem } from "@/components/motion/reveal";

export function PrivacySection() {
  const points = [
    {
      icon: HardDrive,
      title: "Inspect durable history",
      description:
        "Review task changes, document revisions, messages, sessions, and project events in one activity trail."
    },
    {
      icon: EyeOff,
      title: "Stop or disable agents",
      description:
        "Interrupt active work, disable an agent, or revoke access when a workflow should not continue."
    },
    {
      icon: Lock,
      title: "Revoke claims and credentials",
      description:
        "Release stale task ownership and revoke dedicated agent credentials without using a human session token."
    },
    {
      icon: Cpu,
      title: "Approve and reassign work",
      description:
        "Approve or reject review items, request clarification, change priority, and move work to another agent."
    }
  ];

  return (
    <section id="control" className="line-b py-24 md:py-28">
      <div className="max-w-container-lg mx-auto space-y-14 px-6">
        <Reveal>
          <div className="max-w-xl space-y-3">
            <h2 className="text-2xl leading-tight font-semibold tracking-tight text-zinc-100 sm:text-3xl">
              Human control is part of the system.
            </h2>
            <p className="text-sm leading-relaxed font-light text-zinc-500">
              See active work, inspect project history, and intervene when an
              agent needs direction or access must change.
            </p>
          </div>
        </Reveal>

        <RevealStagger
          className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4"
          staggerDelay={0.07}
        >
          {points.map((p, idx) => {
            const Icon = p.icon;
            return (
              <RevealItem key={idx}>
                <div className="flex h-full flex-col gap-4 rounded-xl border border-white/5 bg-zinc-900/30 p-5 transition-colors duration-300 hover:border-white/9">
                  <div className="w-fit rounded-lg bg-zinc-800/50 p-2.5 text-zinc-500">
                    <Icon className="h-4 w-4" strokeWidth={1.5} />
                  </div>
                  <div className="space-y-1.5">
                    <h3 className="text-sm leading-snug font-medium text-zinc-200">
                      {p.title}
                    </h3>
                    <p className="text-xs leading-relaxed font-light text-zinc-600">
                      {p.description}
                    </p>
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
