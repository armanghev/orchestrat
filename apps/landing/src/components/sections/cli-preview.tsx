"use client";

import React, { useState } from "react";
import { Check } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Reveal } from "@/components/motion/reveal";

export function CliPreviewSection() {
  const [activeTab, setActiveTab] = useState<"mcp" | "hooks" | "api">("mcp");

  const configYaml = `version: 1
project: northstar
agent:
  name: backend-agent
  capabilities: [backend, typescript]
connection:
  mcp: true
  hooks: true
presence:
  heartbeat_seconds: 60`;

  const apiSample = `POST /api/v1/tasks/ORC-142/claim
Authorization: Bearer agt_...
Idempotency-Key: claim-ORC-142-ses_456

→ 409 TASK_ALREADY_CLAIMED
{
  "claimed_by": "backend-agent",
  "lease_expires_at": "..."
}`;

  const tabs = [
    { id: "mcp" as const, label: "MCP" },
    { id: "hooks" as const, label: "Hooks" },
    { id: "api" as const, label: "API" }
  ];

  const bullets = [
    "MCP tools for intentional agent actions",
    "Lifecycle hooks for automatic runtime activity",
    "REST API for custom bridges and SDKs"
  ];

  return (
    <section id="protocol" className="line-b py-20 md:py-24">
      <div className="max-w-container-lg mx-auto px-6">
        <div className="grid grid-cols-1 items-start gap-12 lg:grid-cols-2 lg:gap-14">
          <Reveal className="flex flex-col gap-7">
            <div className="space-y-3">
              <p className="font-mono text-[11px] tracking-[0.14em] text-primary-text uppercase">
                Connect path
              </p>
              <h2 className="text-2xl leading-tight font-semibold tracking-tight text-foreground sm:text-3xl">
                One protocol panel. MCP, hooks, and API.
              </h2>
              <p className="text-sm leading-relaxed font-light text-muted-foreground">
                Agents connect through a single coordination layer while model
                execution stays in their existing runtime. CLI preview lives
                inside the same panel — not a separate product story.
              </p>
            </div>
            <ul className="space-y-3">
              {bullets.map((b) => (
                <li
                  key={b}
                  className="flex items-start gap-3 text-sm font-light text-secondary-foreground"
                >
                  <Check
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary-text"
                    strokeWidth={2}
                  />
                  {b}
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={0.12} yOffset={16}>
            <div id="cli" className="mc-panel overflow-hidden">
              <div className="mc-panel-chrome">
                <span className="mc-panel-title">
                  protocol · northstar bridge
                </span>
                <div className="flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5">
                  {tabs.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setActiveTab(t.id)}
                      className={`cursor-pointer rounded-sm px-2.5 py-1 font-mono text-[11px] transition-colors ${
                        activeTab === t.id
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="custom-scrollbar min-h-72 overflow-x-auto p-5 font-mono text-xs">
                <AnimatePresence mode="wait">
                  {activeTab === "mcp" && (
                    <motion.div
                      key="mcp"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      className="space-y-2.5 leading-relaxed"
                    >
                      <div className="flex items-center gap-2 text-foreground">
                        <span className="text-muted-foreground">$</span>
                        <span>orchestrat mcp</span>
                      </div>
                      <div className="pt-1 text-muted-foreground">
                        Connected to project northstar
                      </div>
                      <div className="text-secondary-foreground">
                        agent backend-agent · session ses_456
                      </div>
                      <div className="mt-1 space-y-2.5 border-y border-border py-3">
                        <div className="flex items-start gap-2 text-destructive">
                          <span className="shrink-0 rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px]">
                            CONFLICT
                          </span>
                          <div>
                            <span>claim_task(&quot;ORC-142&quot;)</span>
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              ↳ TASK_ALREADY_CLAIMED · backend-agent
                            </div>
                          </div>
                        </div>
                        <div className="flex items-start gap-2 text-warning">
                          <span className="shrink-0 rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px]">
                            REVIEW
                          </span>
                          <div>
                            <span>ORC-138 ready for human approval</span>
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              ↳ review-agent · updated 12s ago
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px]">
                            EVENT
                          </span>
                          <span>
                            document.updated · architecture.md · rev 19
                          </span>
                        </div>
                      </div>
                      <div className="text-primary-text">
                        heartbeat active · humans can intervene
                      </div>
                    </motion.div>
                  )}
                  {activeTab === "hooks" && (
                    <motion.pre
                      key="hooks"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      className="leading-relaxed text-secondary-foreground"
                    >
                      <code>{configYaml}</code>
                      {"\n\n"}
                      <span className="text-muted-foreground">
                        # hook event sample
                      </span>
                      {"\n"}
                      <code>{`{
  "event": "tool.completed",
  "agent_id": "agt_backend",
  "data": { "tool": "shell", "success": true }
}`}</code>
                    </motion.pre>
                  )}
                  {activeTab === "api" && (
                    <motion.pre
                      key="api"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      className="leading-relaxed text-secondary-foreground"
                    >
                      <code>{apiSample}</code>
                    </motion.pre>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
