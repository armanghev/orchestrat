"use client";

import { type CSSProperties, useRef } from "react";
import { AlertTriangle, Check, CircleDashed, X } from "lucide-react";
import {
  AgentMark,
  Eyebrow,
  PauseButton,
  WindowBar,
  agents,
  type AgentId
} from "@/components/landing/agents";
import { entrance, useSequence } from "@/components/landing/use-sequence";

type Tone = "plain" | "muted" | "good" | "bad" | "wait";
type Pane = { agent: AgentId; lines: { text: string; tone: Tone }[] };

const modes = [
  {
    id: "without",
    label: "Without Orchestrat",
    window: "~/acme · 3 terminals",
    panes: [
      {
        agent: "claude",
        lines: [
          { text: "Starting the auth refactor", tone: "plain" },
          { text: "Reading PLAN.md, edited 3 days ago", tone: "muted" },
          { text: "Rewriting session middleware…", tone: "muted" }
        ]
      },
      {
        agent: "codex",
        lines: [
          { text: "Starting the auth refactor", tone: "plain" },
          { text: "Rewriting session middleware…", tone: "muted" },
          { text: "Same files as another agent", tone: "bad" }
        ]
      },
      {
        agent: "cursor",
        lines: [
          { text: "Which plan is current?", tone: "plain" },
          { text: "Found PLAN.md, plan-v2.md, notes.txt", tone: "muted" },
          { text: "Waiting for you to paste context", tone: "wait" }
        ]
      }
    ] satisfies Pane[],
    outcomes: [
      "Two agents on the same task",
      "Three versions of the plan",
      "You relay every update"
    ]
  },
  {
    id: "with",
    label: "With Orchestrat",
    window: "~/acme · Orchestrat project",
    panes: [
      {
        agent: "codex",
        lines: [
          { text: "Claimed ORC-142 · Auth refactor", tone: "good" },
          { text: "Read architecture.md · revision 19", tone: "muted" },
          { text: "Rewriting session middleware…", tone: "muted" }
        ]
      },
      {
        agent: "claude",
        lines: [
          { text: "ORC-142 is claimed by Codex", tone: "muted" },
          { text: "Claimed ORC-143 · Token rotation", tone: "good" },
          {
            text: "Posted in #auth: building on your middleware",
            tone: "muted"
          }
        ]
      },
      {
        agent: "cursor",
        lines: [
          { text: "Read architecture.md · revision 19", tone: "good" },
          { text: "Claimed ORC-144 · Login screen", tone: "good" },
          { text: "Asked for a review in #auth", tone: "muted" }
        ]
      }
    ] satisfies Pane[],
    outcomes: [
      "One owner per task",
      "One current plan",
      "Agents check in with each other"
    ]
  }
];
const durations = [7000, 7000];

const toneClass: Record<Tone, string> = {
  plain: "text-foreground",
  muted: "text-muted-foreground",
  good: "text-foreground",
  bad: "text-destructive",
  wait: "text-warning"
};

function LineIcon({ tone }: { tone: Tone }) {
  if (tone === "good")
    return (
      <Check
        size={14}
        className="mt-0.5 shrink-0 text-success"
        aria-hidden="true"
      />
    );
  if (tone === "bad")
    return (
      <AlertTriangle
        size={14}
        className="mt-0.5 shrink-0 text-destructive"
        aria-hidden="true"
      />
    );
  if (tone === "wait")
    return (
      <CircleDashed
        size={14}
        className="mt-0.5 shrink-0 text-warning"
        aria-hidden="true"
      />
    );
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 w-3.5 shrink-0 font-mono text-xs text-muted-foreground"
    >
      ›
    </span>
  );
}

export function BeforeAfterSection() {
  const {
    ref,
    step,
    setStep,
    paused,
    setPaused,
    inView,
    seen,
    ready,
    reduced
  } = useSequence<HTMLDivElement>(durations, { restStep: 0, threshold: 0.35 });
  const enter = entrance(ready, seen);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  function select(index: number, focus = false) {
    setPaused(true);
    setStep(index);
    if (focus) tabs.current[index]?.focus();
  }

  return (
    <section
      id="before-after"
      aria-labelledby="before-after-heading"
      className="site-container section-space"
    >
      <div className="section-head">
        <Eyebrow>Sound familiar?</Eyebrow>
        <h2 id="before-after-heading" className="section-title">
          Three agents. One repo.
          <br />
          <span className="text-muted-foreground">
            No idea who is doing what.
          </span>
        </h2>
        <p className="section-copy">
          Every coding agent starts from its own chat. Without a shared place to
          check, they duplicate work, follow stale plans, and wait on you to
          carry context between them.
        </p>
      </div>

      <div
        id="compare"
        className="mb-8 flex scroll-mt-28 items-center justify-center gap-3"
      >
        <div
          role="tablist"
          aria-label="Compare workflows"
          className="toggle-group"
          onFocus={() => setPaused(true)}
        >
          {modes.map((option, index) => (
            <button
              key={option.id}
              ref={(node) => {
                tabs.current[index] = node;
              }}
              id={`compare-tab-${option.id}`}
              type="button"
              role="tab"
              aria-selected={step === index}
              aria-controls={`compare-panel-${option.id}`}
              tabIndex={step === index ? 0 : -1}
              className="toggle-option"
              onClick={() => select(index)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft")
                  return;
                event.preventDefault();
                select((index + 1) % modes.length, true);
              }}
            >
              {option.label}
              {step === index && !paused && !reduced && (
                <span
                  key={`${index}-${inView}`}
                  aria-hidden="true"
                  className="toggle-progress"
                  style={
                    {
                      animationDuration: `${durations[index]}ms`,
                      animationPlayState: inView ? "running" : "paused"
                    } as CSSProperties
                  }
                />
              )}
            </button>
          ))}
        </div>
        {!reduced && (
          <PauseButton
            paused={paused}
            onToggle={() => setPaused((value) => !value)}
            label="comparison"
          />
        )}
      </div>

      {/* Both modes share one grid cell so switching never changes the height. */}
      <div ref={ref} className="mx-auto grid max-w-6xl">
        {modes.map((mode, index) => {
          const active = index === step;
          const good = mode.id === "with";
          const animate = active ? enter : "";
          return (
            <div
              key={`${mode.id}-${active}`}
              id={`compare-panel-${mode.id}`}
              role="tabpanel"
              aria-labelledby={`compare-tab-${mode.id}`}
              inert={!active}
              className={`[grid-area:1/1] ${active ? "" : "invisible"}`}
            >
              <div className="window">
                <WindowBar
                  title={mode.window}
                  right={
                    <span
                      className={
                        good
                          ? "status bg-success/10 text-success"
                          : "status bg-destructive/10 text-destructive"
                      }
                    >
                      {good ? "Coordinated" : "Out of sync"}
                    </span>
                  }
                />
                <div className="grid divide-y lg:grid-cols-3 lg:divide-x lg:divide-y-0">
                  {mode.panes.map((pane, paneIndex) => (
                    <div key={pane.agent} className="min-w-0 p-5 sm:p-6">
                      <div
                        className={`${animate} mb-5 flex items-center gap-2.5`}
                        style={
                          { "--delay": `${paneIndex * 120}ms` } as CSSProperties
                        }
                      >
                        <AgentMark agent={pane.agent} className="size-6" />
                        <span className="text-sm font-medium whitespace-nowrap">
                          {agents[pane.agent].name}
                        </span>
                        <span className="ml-auto font-mono text-[10px] whitespace-nowrap text-muted-foreground">
                          session {paneIndex + 1}
                        </span>
                      </div>
                      <ul className="space-y-3.5 font-mono text-[12.5px] leading-5">
                        {pane.lines.map((line, lineIndex) => (
                          <li
                            key={line.text}
                            className={`${animate} flex items-start gap-2.5 ${toneClass[line.tone]}`}
                            style={
                              {
                                "--delay": `${300 + lineIndex * 420 + paneIndex * 140}ms`
                              } as CSSProperties
                            }
                          >
                            <LineIcon tone={line.tone} />
                            <span className="min-w-0">{line.text}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
              <ul
                className="mt-6 grid gap-3 sm:grid-cols-3"
                aria-label={good ? "With Orchestrat" : "Without Orchestrat"}
              >
                {mode.outcomes.map((outcome, outcomeIndex) => (
                  <li
                    key={outcome}
                    className={`${animate} flex items-center gap-3 rounded-lg border bg-card/40 px-4 py-3.5 text-sm`}
                    style={
                      {
                        "--delay": `${1500 + outcomeIndex * 120}ms`
                      } as CSSProperties
                    }
                  >
                    {good ? (
                      <Check
                        size={16}
                        className="shrink-0 text-success"
                        aria-hidden="true"
                      />
                    ) : (
                      <X
                        size={16}
                        className="shrink-0 text-destructive"
                        aria-hidden="true"
                      />
                    )}
                    {outcome}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
