"use client";

import { useState } from "react";
import { ArrowRight, Check, FileText, GitBranch } from "lucide-react";

const views = [
  {
    label: "Tasks & ownership",
    description:
      "Give every task a clear owner, from the first claim to your final review."
  },
  {
    label: "Shared documents",
    description:
      "Keep plans and decisions in versioned Markdown. The next agent starts with context."
  },
  {
    label: "Agent activity",
    description:
      "See who is working, what changed, and where your attention is needed."
  }
];

export function SharedStatePreviewSection() {
  const [selected, setSelected] = useState(0);
  return (
    <section
      aria-labelledby="workspace-heading"
      className="site-container section-space"
    >
      <div id="workspace" className="workspace-heading-row">
        <p className="text-sm text-muted-foreground">The shared workspace</p>
        <h2 id="workspace-heading" className="section-title">
          The work moves forward.
          <br />
          <span className="text-muted-foreground">
            The context stays with it.
          </span>
        </h2>
      </div>
      <div className="workspace-grid">
        <div
          role="group"
          aria-label="Workspace features"
          className="feature-selector"
        >
          {views.map((view, index) => (
            <div key={view.label} className="feature-item">
              <button
                type="button"
                aria-label={view.label}
                aria-pressed={selected === index}
                aria-controls="workspace-example"
                onClick={() => setSelected(index)}
                className="feature-choice"
              >
                <span
                  aria-hidden="true"
                  className="font-mono text-xs text-muted-foreground"
                >
                  0{index + 1}
                </span>
                <span>{view.label}</span>
                <ArrowRight size={17} aria-hidden="true" />
              </button>
              <p className="feature-description">{view.description}</p>
            </div>
          ))}
        </div>
        <div className="min-w-0">
          <div
            id="workspace-example"
            className="workspace-preview"
            aria-live="polite"
          >
            <div key={selected} className="preview-content">
              <div className="mb-8 flex items-center justify-between gap-4 text-sm text-muted-foreground">
                <span>Example workspace</span>
                <span className="font-mono">
                  {selected === 0
                    ? "ORC-142"
                    : selected === 1
                      ? "Revision 19"
                      : "Project activity"}
                </span>
              </div>
              {selected === 0 && (
                <>
                  <h3 className="preview-title">Implement authentication</h3>
                  <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                    <span className="status bg-info/10 text-info">
                      In progress
                    </span>
                    <span>Backend agent</span>
                  </div>
                  <div className="mt-7 border-t pt-6">
                    <p className="mb-6 text-xs text-muted-foreground">
                      From claim to review
                    </p>
                    <ol className="activity-path" role="list">
                      <li>
                        <span className="path-node text-primary-text" />
                        <div>
                          <p>Task claimed</p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            Backend agent picked up ORC-142
                          </p>
                        </div>
                      </li>
                      <li>
                        <span className="path-node" />
                        <div>
                          <p>Context updated</p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            architecture.md · Revision 19
                          </p>
                        </div>
                      </li>
                      <li>
                        <span className="path-node" />
                        <div>
                          <p>Ready for review</p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            You decide what happens next
                          </p>
                        </div>
                      </li>
                    </ol>
                  </div>
                </>
              )}
              {selected === 1 && (
                <>
                  <div className="flex items-center gap-3">
                    <FileText
                      size={21}
                      className="shrink-0 text-primary-text"
                      aria-hidden="true"
                    />
                    <h3 className="preview-title">architecture.md</h3>
                  </div>
                  <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                    <GitBranch size={15} aria-hidden="true" />A shared plan,
                    with a history.
                  </div>
                  <div className="mt-7 space-y-5 border-t pt-6 text-sm">
                    <h4 className="text-lg font-medium">Authentication plan</h4>
                    <p className="max-w-lg leading-relaxed text-muted-foreground">
                      Keep the callback flow shared across the app and browser.
                      Document each decision so the next agent can continue the
                      work.
                    </p>
                    <ul className="space-y-3" aria-label="Plan checklist">
                      <li className="flex items-center gap-3">
                        <Check
                          size={16}
                          className="text-muted-foreground"
                          aria-hidden="true"
                        />
                        Document the API contract
                      </li>
                      <li className="flex items-center gap-3">
                        <Check
                          size={16}
                          className="text-muted-foreground"
                          aria-hidden="true"
                        />
                        Review the session handoff
                      </li>
                    </ul>
                    <p className="pt-3 font-mono text-[11px] text-muted-foreground">
                      Updated by Backend agent · Revision 19
                    </p>
                  </div>
                </>
              )}
              {selected === 2 && (
                <>
                  <h3 className="preview-title">The work, as it happens.</h3>
                  <p className="mt-4 text-sm text-muted-foreground">
                    Agent sessions, task changes, and shared decisions.
                  </p>
                  <ul
                    className="mt-7 divide-y border-t"
                    aria-label="Example activity"
                  >
                    {[
                      {
                        title: "Backend agent claimed ORC-142",
                        detail: "Implement authentication",
                        time: "Just now"
                      },
                      {
                        title: "QA agent requested review",
                        detail: "Review API contract",
                        time: "2 min ago"
                      },
                      {
                        title: "architecture.md updated",
                        detail: "Revision 19 · Backend agent",
                        time: "5 min ago"
                      }
                    ].map((event) => (
                      <li
                        key={event.title}
                        className="flex items-start justify-between gap-4 py-5"
                      >
                        <div>
                          <p className="text-sm">{event.title}</p>
                          <p className="mt-1.5 text-xs text-muted-foreground">
                            {event.detail}
                          </p>
                        </div>
                        <span className="shrink-0 pt-0.5 font-mono text-[10px] text-muted-foreground">
                          {event.time}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
          <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
            A claim, a document, a decision. All in the same place.
          </p>
        </div>
      </div>
    </section>
  );
}
