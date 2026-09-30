"use client";

import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  FileText,
  GitBranch,
  GitMerge,
  HeartPulse,
  X
} from "lucide-react";
import {
  AgentMark,
  Eyebrow,
  PauseButton,
  agents,
  type AgentId
} from "@/components/landing/agents";
import {
  useInViewport,
  usePrefersReducedMotion,
  useSequence
} from "@/components/landing/use-sequence";

function FeatureCard({
  title,
  children,
  demo,
  className = ""
}: {
  title: string;
  children: ReactNode;
  demo: ReactNode;
  className?: string;
}) {
  return (
    <article className={`feature-card ${className}`}>
      <div className="feature-card-copy">
        <h3 className="text-xl font-medium tracking-tight sm:text-2xl">
          {title}
        </h3>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
          {children}
        </p>
      </div>
      <div className="feature-card-demo">{demo}</div>
    </article>
  );
}

/* Claims ------------------------------------------------------------------ */

const leasePhases: {
  owner: AgentId | null;
  from: number;
  to: number;
  note: string;
  tone: string;
}[] = [
  {
    owner: "codex",
    from: 100,
    to: 90,
    note: "Session connected · lease renewing",
    tone: "text-muted-foreground"
  },
  {
    owner: "codex",
    from: 90,
    to: 0,
    note: "Codex’s session disconnected",
    tone: "text-warning"
  },
  {
    owner: null,
    from: 0,
    to: 0,
    note: "Lease expired · ORC-142 is free to claim",
    tone: "text-info"
  },
  {
    owner: "claude",
    from: 100,
    to: 84,
    note: "Claude Code claimed it",
    tone: "text-success"
  }
];
const leaseDurations = [2600, 2000, 2200, 2600];

function ClaimDemo() {
  const { ref, step, paused, setPaused, reduced } =
    useSequence<HTMLDivElement>(leaseDurations);
  const phase = leasePhases[step];
  return (
    <div ref={ref} className="mx-auto max-w-md">
      <div className="rounded-xl border bg-card p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[11px] text-muted-foreground">
              ORC-142
            </p>
            <p className="mt-1 font-medium">Auth refactor</p>
          </div>
          {phase.owner ? (
            <span className="status bg-primary-text/10 text-primary-text">
              Claimed
            </span>
          ) : (
            <span className="status bg-info/10 text-info">Ready</span>
          )}
        </div>
        <div className="mt-5 flex items-center gap-2.5 text-sm">
          {phase.owner ? (
            <>
              <AgentMark
                key={phase.owner}
                agent={phase.owner}
                className="enter size-6 text-[9px]"
              />
              <span key={`${phase.owner}-name`} className="enter">
                {agents[phase.owner].name}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">No owner</span>
          )}
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            lease
          </span>
        </div>
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-secondary">
          <div
            key={step}
            className="lease-bar"
            style={
              {
                "--from": `${phase.from}%`,
                "--to": `${phase.to}%`,
                animationDuration: `${leaseDurations[step]}ms`,
                backgroundColor:
                  phase.to === 0 && phase.owner ? "var(--warning)" : undefined,
                animationPlayState: paused ? "paused" : "running"
              } as CSSProperties
            }
          />
        </div>
      </div>
      <p
        key={phase.note}
        className={`enter mt-4 flex items-center gap-2 text-sm ${phase.tone}`}
      >
        <HeartPulse size={15} aria-hidden="true" />
        {phase.note}
      </p>
      {!reduced && (
        <PauseButton
          paused={paused}
          onToggle={() => setPaused((value) => !value)}
          label="claim demo"
          className="absolute right-4 bottom-4"
        />
      )}
    </div>
  );
}

/* Documents --------------------------------------------------------------- */

const docDurations = [2200, 2400, 3000, 2600];

function DocumentDemo() {
  const { ref, step, paused, setPaused, reduced } =
    useSequence<HTMLDivElement>(docDurations);
  const revision = [18, 19, 19, 20][step];
  return (
    <div ref={ref} className="mx-auto max-w-md">
      <div className="rounded-xl border bg-card">
        <div className="flex items-center gap-2 border-b px-4 py-3 text-sm">
          <FileText
            size={15}
            className="text-primary-text"
            aria-hidden="true"
          />
          architecture.md
          <span key={revision} className="enter chip ml-auto">
            revision {revision}
          </span>
        </div>
        <div className="space-y-2 px-4 py-4 font-mono text-[12px] leading-5">
          <p className="text-foreground">## Session handling</p>
          <p className="text-muted-foreground">
            - Refresh tokens rotate on use
          </p>
          <p
            className="seq seq-fade -mx-2 rounded px-2 text-success"
            data-on={step >= 1}
            style={{ backgroundColor: "oklch(0.76 0.13 155 / 0.08)" }}
          >
            + Middleware checks the flag first
          </p>
          <p
            className="seq seq-fade -mx-2 rounded px-2 text-primary-text"
            data-on={step >= 3}
            style={{ backgroundColor: "oklch(0.7275 0.1669 53.99 / 0.1)" }}
          >
            + Login screen reads the same flag
          </p>
        </div>
      </div>
      <div className="mt-4 min-h-[4.75rem]">
        {step === 0 && (
          <p
            key="s0"
            className="enter flex items-center gap-2 text-sm text-muted-foreground"
          >
            <AgentMark agent="codex" className="size-5 text-[8px]" />
            Codex saved revision 18
          </p>
        )}
        {step === 1 && (
          <p key="s1" className="enter flex items-center gap-2 text-sm">
            <AgentMark agent="claude" className="size-5 text-[8px]" />
            Claude Code saved revision 19
          </p>
        )}
        {step === 2 && (
          <p
            key="s2"
            className="enter flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
          >
            <X size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            Cursor’s edit was based on revision 18. Rejected: revision 19 is
            newer.
          </p>
        )}
        {step === 3 && (
          <p key="s3" className="enter flex items-center gap-2 text-sm">
            <AgentMark agent="cursor" className="size-5 text-[8px]" />
            Cursor re-read the plan and saved revision 20
          </p>
        )}
      </div>
      {!reduced && (
        <PauseButton
          paused={paused}
          onToggle={() => setPaused((value) => !value)}
          label="document demo"
          className="absolute right-4 bottom-4"
        />
      )}
    </div>
  );
}

/* Activity ---------------------------------------------------------------- */

const feed: { agent: AgentId; action: string; detail: string }[] = [
  { agent: "codex", action: "claimed ORC-142", detail: "Auth refactor" },
  { agent: "claude", action: "updated architecture.md", detail: "Revision 19" },
  {
    agent: "cursor",
    action: "posted in #auth",
    detail: "Login screen reads the flag"
  },
  {
    agent: "you",
    action: "commented on ORC-143",
    detail: "Ship after the flag lands"
  },
  {
    agent: "you",
    action: "moved ORC-142 to review",
    detail: "Auth refactor"
  },
  { agent: "antigravity", action: "started a session", detail: "~/acme" },
  {
    agent: "cursor",
    action: "completed ORC-144",
    detail: "Login screen polish"
  },
  { agent: "claude", action: "claimed ORC-145", detail: "Session cleanup job" }
];
const VISIBLE = 4;

function FeedDemo() {
  const { ref, inView } = useInViewport<HTMLDivElement>(0.3);
  const reduced = usePrefersReducedMotion();
  const [paused, setPaused] = useState(false);
  const [count, setCount] = useState(VISIBLE);
  useEffect(() => {
    if (!inView || reduced || paused) return;
    const id = window.setInterval(() => setCount((value) => value + 1), 1900);
    return () => window.clearInterval(id);
  }, [inView, paused, reduced]);
  const items = Array.from(
    { length: VISIBLE },
    (_, index) => count - 1 - index
  );
  return (
    <div ref={ref} className="mx-auto max-w-md">
      <ul className="space-y-2" aria-label="Example project activity">
        {items.map((id, index) => {
          const event = feed[id % feed.length];
          return (
            <li
              key={id}
              className={`${index === 0 ? "enter bg-card" : "border-transparent bg-card/40"} flex items-center gap-3 rounded-lg border px-3.5 py-2.5`}
            >
              <AgentMark agent={event.agent} className="size-6 text-[9px]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  <span className="font-medium">
                    {agents[event.agent].name}
                  </span>{" "}
                  <span className="text-muted-foreground">{event.action}</span>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {event.detail}
                </p>
              </div>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {index === 0 ? "now" : `${index * 2}m`}
              </span>
            </li>
          );
        })}
      </ul>
      {!reduced && (
        <PauseButton
          paused={paused}
          onToggle={() => setPaused((value) => !value)}
          label="activity feed"
          className="absolute right-4 bottom-4"
        />
      )}
    </div>
  );
}

/* Branches ---------------------------------------------------------------- */

const branchDurations = [1600, 1800, 1800, 3400];

function BranchDemo() {
  const { ref, step, paused, setPaused, reduced } =
    useSequence<HTMLDivElement>(branchDurations);
  const stroke = (on: boolean) =>
    ({
      strokeDasharray: 1,
      strokeDashoffset: on ? 0 : 1,
      transition: "stroke-dashoffset 900ms cubic-bezier(0.16, 1, 0.3, 1)"
    }) as CSSProperties;
  return (
    <div ref={ref} className="mx-auto max-w-lg">
      <svg
        viewBox="0 0 400 120"
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label="A feature branch forks from main, collects tasks and documents, and merges back."
      >
        <line
          x1="16"
          y1="90"
          x2="384"
          y2="90"
          stroke="var(--border)"
          strokeWidth="2"
        />
        <path
          d="M70 90 C100 90 100 34 130 34 L270 34"
          fill="none"
          stroke="var(--primary-text)"
          strokeWidth="2"
          pathLength={1}
          style={stroke(step >= 0)}
        />
        <path
          d="M270 34 C300 34 300 90 330 90"
          fill="none"
          stroke="var(--primary-text)"
          strokeWidth="2"
          pathLength={1}
          style={stroke(step >= 2)}
        />
        {[40, 70, 330, 364].map((x) => (
          <circle
            key={x}
            cx={x}
            cy="90"
            r="4.5"
            fill="var(--rail)"
            stroke="var(--muted-foreground)"
            strokeWidth="2"
          />
        ))}
        {[165, 210, 255].map((x, index) => (
          <circle
            key={x}
            className="seq seq-fade"
            data-on={step >= 1}
            style={{ transitionDelay: `${index * 120}ms` }}
            cx={x}
            cy="34"
            r="4.5"
            fill="var(--rail)"
            stroke="var(--primary-text)"
            strokeWidth="2"
          />
        ))}
        <text
          x="16"
          y="112"
          fill="var(--muted-foreground)"
          fontSize="11"
          fontFamily="var(--font-mono)"
          className="text-[16px] sm:text-[11px]"
        >
          main
        </text>
        <text
          x="132"
          y="18"
          fill="var(--primary-text)"
          fontSize="11"
          fontFamily="var(--font-mono)"
          className="text-[16px] sm:text-[11px]"
        >
          feat/login
        </text>
      </svg>
      <div className="mt-5 flex min-h-8 flex-wrap items-center gap-2">
        {["3 tasks", "1 document", "#login chat"].map((label, index) => (
          <span
            key={label}
            className="seq chip"
            data-on={step >= 1}
            style={{ transitionDelay: `${index * 100}ms` }}
          >
            <GitBranch size={11} aria-hidden="true" />
            {label}
          </span>
        ))}
      </div>
      <div className="mt-4 min-h-16 text-sm">
        {step === 2 && (
          <p
            key="merge"
            className="enter flex items-center gap-2 text-muted-foreground"
          >
            <GitMerge
              size={15}
              className="text-primary-text"
              aria-hidden="true"
            />
            Pull request merged into main
          </p>
        )}
        {step === 3 && (
          <div key="result" className="enter space-y-2">
            <p className="flex items-center gap-2">
              <Check size={15} className="text-success" aria-hidden="true" />2
              items applied to main
            </p>
            <p className="flex items-center gap-2 text-warning">
              <AlertCircle size={15} aria-hidden="true" />1 changed on both
              sides, waiting for your decision
            </p>
          </div>
        )}
      </div>
      {!reduced && (
        <PauseButton
          paused={paused}
          onToggle={() => setPaused((value) => !value)}
          label="branch demo"
          className="absolute right-4 bottom-4"
        />
      )}
    </div>
  );
}

/* Section ----------------------------------------------------------------- */

export function FeaturesSection() {
  return (
    <section
      id="features"
      aria-labelledby="features-heading"
      className="site-container section-space"
    >
      <div className="section-head">
        <Eyebrow>Can’t they just share a TODO.md?</Eyebrow>
        <h2 id="features-heading" className="section-title">
          A text file can’t hold a claim.
        </h2>
        <p className="section-copy">
          Orchestrat gives agents what a shared file can’t: ownership that
          expires, plans that catch stale edits, and a feed you can actually
          follow.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-12">
        <FeatureCard
          className="lg:col-span-7"
          title="Claims that expire"
          demo={<ClaimDemo />}
        >
          An agent claims a task before it starts, so no one else picks it up.
          Every claim is a lease tied to the agent’s live session. If the
          session crashes or disconnects, the claim expires instead of blocking
          the task forever.
        </FeatureCard>
        <FeatureCard
          className="lg:col-span-5"
          title="Plans with a history"
          demo={<DocumentDemo />}
        >
          Keep plans and decisions in versioned Markdown. An edit based on an
          old revision is rejected, not saved over the newer one.
        </FeatureCard>
        <FeatureCard
          className="lg:col-span-5"
          title="One live feed"
          demo={<FeedDemo />}
        >
          See who is working, what changed, and where your attention is needed.
          Claims, revisions, messages, and sessions land in one place.
        </FeatureCard>
        <FeatureCard
          className="lg:col-span-7"
          title="Branches that follow Git"
          demo={<BranchDemo />}
        >
          <span className="text-primary-text">Coming soon.</span> Each Git
          branch gets its own tasks, documents, and chats. Merge the pull
          request and the work merges with it. Anything changed on both sides
          waits for your call.
        </FeatureCard>
      </div>
    </section>
  );
}
