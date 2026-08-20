"use client";

import React, { useState } from "react";
import {
  ShieldAlert,
  CheckCircle2,
  Copy,
  Check,
  Lock,
  Globe
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Reveal, RevealStagger, RevealItem } from "@/components/motion/reveal";

export function SharedStatePreviewSection() {
  const [activeCase, setActiveCase] = useState<number>(0);
  const [copied, setCopied] = useState<boolean>(false);

  const cases = [
    {
      title: "Task already claimed",
      category: "Task coordination",
      icon: Lock,
      severity: "Conflict",
      problem: "ORC-142 already has an active lease owned by backend-agent.",
      explanation:
        "Atomic claiming prevents duplicate work. The second agent receives a machine-readable conflict and can choose another ready task.",
      file: "ORC-142 · active claim",
      beforeCode: `claim_task({
  task_id: "ORC-142",
  agent_id: "frontend-agent",
  expected_version: 17
});`,
      afterCode: `{
  "error": {
    "code": "TASK_ALREADY_CLAIMED",
    "task_id": "ORC-142",
    "claimed_by": "backend-agent"
  }
}`
    },
    {
      title: "Document revision changed",
      category: "Shared documents",
      icon: Globe,
      severity: "Conflict",
      problem:
        "architecture.md is now revision 19; this edit used revision 18.",
      explanation:
        "Revision checks prevent one agent from silently overwriting another agent's update. The stale writer reads, merges, and retries.",
      file: "architecture.md · revision 19",
      beforeCode: `update_document({
  path: "architecture.md",
  base_revision: 18,
  content: "..."
});`,
      afterCode: `{
  "error": {
    "code": "DOCUMENT_CONFLICT",
    "current_revision": 19,
    "base_revision": 18
  }
}`
    },
    {
      title: "Work ready for review",
      category: "Human control",
      icon: ShieldAlert,
      severity: "Review",
      problem: "review-agent moved ORC-138 into the review queue.",
      explanation:
        "A human can inspect the task history, approve or reject the work, request clarification, or reassign ownership.",
      file: "ORC-138 · review requested",
      beforeCode: `update_task({
  task_id: "ORC-138",
  status: "review",
  expected_version: 8
});`,
      afterCode: `{
  "event": "task.review_requested",
  "actor": "review-agent",
  "task_id": "ORC-138",
  "version": 9
}`
    }
  ];

  const current = cases[activeCase];

  const handleCopyCode = () => {
    navigator.clipboard.writeText(current.afterCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const severityStyle: Record<string, string> = {
    Conflict: "text-red-400/70 bg-red-950/40 border-red-900/30",
    Review: "text-amber-400/60 bg-amber-950/40 border-amber-900/30"
  };

  return (
    <section id="workspace" className="line-b relative py-24 md:py-32">
      <div className="max-w-container-lg mx-auto px-6">
        {/* Section Header */}
        <Reveal>
          <div className="max-w-xl space-y-3">
            <h2 className="text-2xl leading-tight font-semibold tracking-tight text-zinc-100 sm:text-3xl">
              One shared state for every participant.
            </h2>
            <p className="text-sm leading-relaxed font-light text-zinc-500">
              Tasks, claims, documents, messages, and events stay available
              across agent sessions, with conflicts surfaced instead of silently
              overwritten.
            </p>
          </div>
        </Reveal>

        {/* Tabs Switcher */}
        <RevealStagger className="mt-10 flex flex-wrap gap-2">
          {cases.map((item, idx) => {
            const Icon = item.icon;
            const isSelected = activeCase === idx;
            return (
              <RevealItem key={idx}>
                <button
                  onClick={() => setActiveCase(idx)}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3.5 py-2 font-mono text-xs transition-all ${
                    isSelected
                      ? "border-white/1 bg-zinc-800 text-zinc-200"
                      : "border-transparent bg-transparent text-zinc-600 hover:text-zinc-400"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                  <span>{item.title}</span>
                  <span
                    className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${severityStyle[item.severity]}`}
                  >
                    {item.severity}
                  </span>
                </button>
              </RevealItem>
            );
          })}
        </RevealStagger>

        {/* Selected shared-state detail and response */}
        <Reveal delay={0.12} yOffset={16}>
          <AnimatePresence mode="wait">
            <motion.div
              key={activeCase}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-[380px_1fr]"
            >
              {/* Left Side: Context */}
              <div className="h-full rounded-2xl border border-white/6 bg-zinc-900/40 p-1.5">
                <div className="space-y-4 rounded-xl border border-white/5 bg-zinc-950 p-5 font-mono text-xs">
                  <div className="flex items-center justify-between border-b border-white/5 pb-3">
                    <div>
                      <span className="block text-[10px] tracking-wider text-zinc-600 uppercase">
                        {current.category}
                      </span>
                      <span className="mt-0.5 block text-[11px] font-medium text-zinc-400">
                        Shared state
                      </span>
                    </div>
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[9px] ${severityStyle[current.severity]}`}
                    >
                      {current.severity}
                    </span>
                  </div>

                  <div className="space-y-3.5">
                    <div>
                      <span className="block text-[10px] text-zinc-700 uppercase">
                        Current state:
                      </span>
                      <p className="mt-0.5 leading-relaxed font-light text-zinc-300">
                        {current.problem}
                      </p>
                    </div>

                    <div>
                      <span className="block text-[10px] text-zinc-700 uppercase">
                        Why it matters:
                      </span>
                      <p className="mt-0.5 leading-relaxed font-light text-zinc-500">
                        {current.explanation}
                      </p>
                    </div>

                    <div className="border-t border-white/5 pt-3">
                      <span className="block text-[10px] text-zinc-700 uppercase">
                        Entity:
                      </span>
                      <code className="mt-0.5 block text-[11px] break-all text-zinc-400">
                        {current.file}
                      </code>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right Side: Before/After Code */}
              <div className="space-y-4 font-mono text-xs">
                {/* Before */}
                <div className="overflow-hidden rounded-xl border border-red-500/15 bg-zinc-950/80">
                  <div className="flex items-center justify-between border-b border-red-500/10 bg-red-950/10 px-4 py-2 text-red-400/70">
                    <span>Agent request</span>
                    <span className="text-[9px] text-red-500/50 uppercase">
                      Request
                    </span>
                  </div>
                  <pre className="overflow-x-auto p-4 leading-relaxed text-red-400/60 select-none">
                    <code>{current.beforeCode}</code>
                  </pre>
                </div>

                {/* After */}
                <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/80">
                  <div className="flex items-center justify-between border-b border-white/5 bg-zinc-900/30 px-4 py-2 text-zinc-400">
                    <span className="flex items-center gap-1.5 text-zinc-300">
                      <CheckCircle2
                        className="h-3.5 w-3.5 text-zinc-500"
                        strokeWidth={1.5}
                      />
                      orchestrat response
                    </span>
                    <button
                      onClick={handleCopyCode}
                      className="flex cursor-pointer items-center gap-1.5 rounded border border-white/5 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800"
                    >
                      {copied ? (
                        <Check className="h-3 w-3 text-zinc-500" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      <span>{copied ? "Copied" : "Copy"}</span>
                    </button>
                  </div>
                  <pre className="overflow-x-auto p-4 leading-relaxed text-zinc-300">
                    <code>{current.afterCode}</code>
                  </pre>
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
        </Reveal>
      </div>
    </section>
  );
}
