"use client";

import React from "react";
import { motion } from "motion/react";
import {
  ShieldCheck,
  CheckCircle2,
  Lock,
  Activity,
  Eye,
  Zap,
  Search,
  Globe,
  CreditCard
} from "lucide-react";

export function StatusRail() {
  const statuses = [
    { icon: ShieldCheck, text: "Claims visible" },
    { icon: Lock, text: "Project state shared" },
    { icon: Activity, text: "Heartbeats active" },
    { icon: CheckCircle2, text: "Review gates ready" },
    { icon: Eye, text: "Activity inspectable" },
    { icon: Zap, text: "MCP connected" },
    { icon: Search, text: "Tasks discoverable" },
    { icon: Globe, text: "Documents versioned" },
    { icon: CreditCard, text: "Humans in control" }
  ];

  // Duplicate for seamless loop
  const displayStatuses = [...statuses, ...statuses, ...statuses];

  return (
    <div className="line-b overflow-hidden bg-zinc-950 py-3 select-none">
      <motion.div
        animate={{
          x: [0, -1000]
        }}
        transition={{
          x: {
            repeat: Infinity,
            repeatType: "loop",
            duration: 40,
            ease: "linear"
          }
        }}
        className="flex items-center gap-12 px-6 whitespace-nowrap"
      >
        {displayStatuses.map((s, i) => {
          const Icon = s.icon;
          return (
            <div key={i} className="flex items-center gap-2.5">
              <Icon className="h-3.5 w-3.5 text-zinc-700" strokeWidth={1.5} />
              <span className="font-mono text-[11px] tracking-widest text-zinc-600 uppercase">
                {s.text}
              </span>
              <span className="ml-2 h-1 w-1 rounded-full bg-zinc-800" />
            </div>
          );
        })}
      </motion.div>
    </div>
  );
}
