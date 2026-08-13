"use client";

import React, { useState } from "react";
import { Check } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Reveal } from "@/components/motion/reveal";

export function CliPreviewSection() {
  const [activeTab, setActiveTab] = useState<"terminal" | "config" | "json">(
    "terminal"
  );

  const configYaml = `version: 1
project: northstar
agent:
  name: backend-agent
  capabilities:
    - backend
    - typescript
connection:
  mcp: true
  hooks: true
presence:
  heartbeat_seconds: 60`;

  const jsonOutput = `{
  "event": "tool.completed",
  "timestamp": "2026-08-10T19:43:00Z",
  "agent_id": "agt_backend",
  "session_id": "ses_456",
  "project_id": "prj_northstar",
  "data": {
    "tool": "shell",
    "duration_ms": 1840,
    "success": true
  }
}`;

  const tabs = [
    { id: "terminal" as const, label: "MCP tools" },
    { id: "config" as const, label: "agent.yml" },
    { id: "json" as const, label: "Hook event" }
  ];

  const bullets = [
    "MCP tools for intentional agent actions",
    "Lifecycle hooks for automatic runtime activity",
    "Durable project state available through one shared API"
  ];

  return (
    <section id="protocol" className="line-b py-24 md:py-32">
      <div className="max-w-container-lg mx-auto px-6">
        <div className="grid grid-cols-1 items-start gap-14 lg:grid-cols-2 lg:gap-16">
          {/* Left */}
          <Reveal className="flex flex-col gap-8">
            <div className="space-y-3">
              <h2 className="text-2xl leading-tight font-semibold tracking-tight text-zinc-100 sm:text-3xl">
                One coordination layer. Any capable agent.
              </h2>
              <p className="text-sm leading-relaxed font-light text-zinc-500">
                Agents connect through MCP, hooks, APIs, or a local bridge
                while model execution and tools remain in their existing
                runtime.
              </p>
            </div>
            <ul className="space-y-3">
              {bullets.map((b, i) => (
                <li
                  key={i}
                  className="flex items-start gap-3 text-sm font-light text-zinc-400"
                >
                  <Check
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600"
                    strokeWidth={2}
                  />
                  {b}
                </li>
              ))}
            </ul>
          </Reveal>

          {/* Right: terminal */}
          <Reveal delay={0.15} yOffset={20}>
            <div
              id="cli"
              className="rounded-2xl border border-white/6 bg-zinc-900/40 p-1.5"
            >
              <div className="overflow-hidden rounded-xl border border-white/5 bg-zinc-950 font-mono text-xs">
                {/* Header */}
                <div className="flex items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                    <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                    <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                    <span className="ml-2 text-[11px] text-zinc-600">
                      orchestrat bridge · northstar
                    </span>
                  </div>
                  <div className="flex items-center gap-0.5 rounded-lg border border-white/5 bg-zinc-900 p-0.5">
                    {tabs.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setActiveTab(t.id)}
                        className={`cursor-pointer rounded-md px-3 py-1 text-[11px] transition-all ${
                          activeTab === t.id
                            ? "bg-zinc-800 text-zinc-200"
                            : "text-zinc-600 hover:text-zinc-400"
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Body */}
                <div className="custom-scrollbar min-h-75 overflow-x-auto p-5">
                  <AnimatePresence mode="wait">
                    {activeTab === "terminal" && (
                      <motion.div
                        key="terminal"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="space-y-2.5 leading-relaxed"
                      >
                        <div className="flex items-center gap-2 text-zinc-300">
                          <span className="text-zinc-600">$</span>
                          <span>orchestrat mcp</span>
                        </div>
                        <div className="pt-1 text-zinc-600">
                          Connected to project northstar
                        </div>
                        <div className="text-zinc-400">
                          agent backend-agent · session ses_456
                        </div>
                        <div className="mt-1 space-y-2 border-y border-white/5 py-2.5">
                          <div className="flex items-start gap-2 text-red-400/80">
                            <span className="shrink-0 rounded border border-red-900 bg-red-950 px-1.5 py-0.5 text-[10px]">
                              CONFLICT
                            </span>
                            <div>
                              <span>claim_task(&quot;ORC-142&quot;)</span>
                              <div className="mt-0.5 text-[11px] text-zinc-600">
                                ↳ TASK_ALREADY_CLAIMED · backend-agent
                              </div>
                            </div>
                          </div>
                          <div className="flex items-start gap-2 text-amber-400/70">
                            <span className="shrink-0 rounded border border-amber-900 bg-amber-950 px-1.5 py-0.5 text-[10px]">
                              REVIEW
                            </span>
                            <div>
                              <span>ORC-138 is ready for human approval</span>
                              <div className="mt-0.5 text-[11px] text-zinc-600">
                                ↳ review-agent · updated 12s ago
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 text-zinc-500">
                            <span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px]">
                              EVENT
                            </span>
                            <span>document.updated · architecture.md · rev 19</span>
                          </div>
                        </div>
                        <div className="text-amber-400/70">
                          heartbeat active · humans can intervene
                        </div>
                      </motion.div>
                    )}
                    {activeTab === "config" && (
                      <motion.pre
                        key="config"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="leading-relaxed text-zinc-400"
                      >
                        <code>{configYaml}</code>
                      </motion.pre>
                    )}
                    {activeTab === "json" && (
                      <motion.pre
                        key="json"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="leading-relaxed text-zinc-400"
                      >
                        <code>{jsonOutput}</code>
                      </motion.pre>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
