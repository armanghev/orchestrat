"use client";

import React, { useState } from "react";
import { CheckCircle2, Copy, Check, Lock, Globe, ShieldAlert } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Reveal, RevealStagger, RevealItem } from "@/components/motion/reveal";

export function SharedStatePreviewSection() {
  const [activeCase, setActiveCase] = useState(0);
  const [copied, setCopied] = useState(false);

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
    "claimed_by": "backend-agent",
    "lease_expires_at": "2026-09-15T06:12:00Z"
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
        "Revision checks prevent silent overwrites. The stale writer reads, merges, and retries against the current revision.",
      file: "architecture.md · revision 19",
      beforeCode: `update_document({
  path: "architecture.md",
  base_revision: 18,
  content: "..."
});`,
      afterCode: `{
  "error": {
    "code": "DOCUMENT_CONFLICT",
    "path": "architecture.md",
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
        "A human can inspect history, approve or reject, request clarification, or reassign ownership.",
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

  function handleCopyCode() {
    navigator.clipboard.writeText(current.afterCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const severityStyle: Record<string, string> = {
    Conflict:
      "text-destructive border-destructive/30 bg-destructive/10",
    Review: "text-warning border-warning/30 bg-warning/10"
  };

  return (
    <section id="workspace" className="line-b relative py-20 md:py-24">
      <div className="max-w-container-lg mx-auto px-6">
        <Reveal>
          <div className="max-w-xl space-y-3">
            <p className="font-mono text-[11px] tracking-[0.14em] text-primary-text uppercase">
              Shared state
            </p>
            <h2 className="text-2xl leading-tight font-semibold tracking-tight text-foreground sm:text-3xl">
              Honest conflicts beat silent overwrites.
            </h2>
            <p className="text-sm leading-relaxed font-light text-muted-foreground">
              Tasks, claims, documents, messages, and events stay available
              across agent sessions — with protocol samples that match how
              orchestrat actually responds.
            </p>
          </div>
        </Reveal>

        <RevealStagger className="mt-8 flex flex-wrap gap-2">
          {cases.map((item, idx) => {
            const Icon = item.icon;
            const isSelected = activeCase === idx;
            return (
              <RevealItem key={idx}>
                <button
                  onClick={() => setActiveCase(idx)}
                  className={`flex cursor-pointer items-center gap-2 rounded-md border px-3.5 py-2 font-mono text-xs transition-colors ${
                    isSelected
                      ? "border-border bg-accent text-accent-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
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

        <Reveal delay={0.12} yOffset={16}>
          <AnimatePresence mode="wait">
            <motion.div
              key={activeCase}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="mt-6 grid grid-cols-1 items-start gap-5 lg:grid-cols-[360px_1fr]"
            >
              <div className="mc-panel overflow-hidden">
                <div className="mc-panel-chrome">
                  <span className="mc-panel-title">{current.category}</span>
                  <span
                    className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${severityStyle[current.severity]}`}
                  >
                    {current.severity}
                  </span>
                </div>
                <div className="space-y-4 p-5 font-mono text-xs">
                  <div>
                    <span className="block text-[10px] tracking-wider text-muted-foreground uppercase">
                      Current state
                    </span>
                    <p className="mt-1 leading-relaxed font-light text-secondary-foreground">
                      {current.problem}
                    </p>
                  </div>
                  <div>
                    <span className="block text-[10px] tracking-wider text-muted-foreground uppercase">
                      Why it matters
                    </span>
                    <p className="mt-1 leading-relaxed font-light text-muted-foreground">
                      {current.explanation}
                    </p>
                  </div>
                  <div className="border-t border-border pt-3">
                    <span className="block text-[10px] tracking-wider text-muted-foreground uppercase">
                      Entity
                    </span>
                    <code className="mt-1 block text-[11px] break-all text-primary-text">
                      {current.file}
                    </code>
                  </div>
                </div>
              </div>

              <div className="space-y-4 font-mono text-xs">
                <div className="overflow-hidden rounded-lg border border-destructive/25 bg-card">
                  <div className="flex items-center justify-between border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-destructive">
                    <span>Agent request</span>
                    <span className="text-[9px] uppercase opacity-70">
                      Request
                    </span>
                  </div>
                  <pre className="overflow-x-auto p-4 leading-relaxed text-destructive/80 select-none">
                    <code>{current.beforeCode}</code>
                  </pre>
                </div>

                <div className="overflow-hidden rounded-lg border border-border bg-card">
                  <div className="flex items-center justify-between border-b border-border bg-surface-raised px-4 py-2">
                    <span className="flex items-center gap-1.5 text-secondary-foreground">
                      <CheckCircle2
                        className="h-3.5 w-3.5 text-muted-foreground"
                        strokeWidth={1.5}
                      />
                      orchestrat response
                    </span>
                    <button
                      onClick={handleCopyCode}
                      className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {copied ? (
                        <Check className="h-3 w-3 text-success" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      <span>{copied ? "Copied" : "Copy"}</span>
                    </button>
                  </div>
                  <pre className="overflow-x-auto p-4 leading-relaxed text-secondary-foreground">
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
