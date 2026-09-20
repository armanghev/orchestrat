"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

const examples = [
  {
    name: "CLI",
    code: "npm install -g @orchestrat/cli@alpha\norchestrat setup\norchestrat status",
    note: "Connect once. Keep working in the tools you know."
  },
  {
    name: "MCP",
    code: "orchestrat mcp --integration codex\n\n# Or connect Claude Code\norchestrat mcp --integration claude-code",
    note: "The local bridge gives your agents access to shared project state."
  },
  {
    name: "API",
    code: 'curl "$ORCHESTRAT_API_URL/api/v1/projects/$PROJECT_ID/tasks" \\\n  -H "Authorization: Bearer $ACCESS_TOKEN"',
    note: "Use your API URL, project ID, and access token to read project tasks."
  }
];
const connections = [
  { name: "MCP", detail: "A shared project context for your agents." },
  { name: "Hooks", detail: "Keep task and session activity connected." },
  { name: "API", detail: "Read and update project state from your tools." }
];

export function CliPreviewSection() {
  const [selected, setSelected] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const current = examples[selected];
  async function copy() {
    try {
      await navigator.clipboard.writeText(current.code);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  }
  return (
    <section
      aria-labelledby="protocol-heading"
      className="site-container section-space pt-6 pb-0 md:pt-12 lg:pt-16"
    >
      <div
        id="protocol"
        className="mb-12 grid gap-6 lg:grid-cols-[1.9fr_1fr] lg:items-center lg:gap-16"
      >
        <h2 id="protocol-heading" className="section-title">
          Your tools stay.
          <br />
          <span className="text-muted-foreground">The context connects.</span>
        </h2>
        <p className="section-copy max-w-sm">
          Bring your coding tools. Orchestrat coordinates the tasks, documents,
          and activity around them.
        </p>
      </div>
      <div className="integration-grid">
        <dl className="divide-y">
          {connections.map((connection) => (
            <div key={connection.name} className="py-7 first:pt-1 last:pb-1">
              <dt className="text-xl font-medium tracking-tight">
                {connection.name}
              </dt>
              <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {connection.detail}
              </dd>
            </div>
          ))}
        </dl>
        <div className="command-panel">
          <div className="flex items-center justify-between gap-3 border-b px-5 sm:px-7">
            <div
              role="group"
              aria-label="Connection examples"
              className="flex gap-5 sm:gap-7"
            >
              {examples.map((example, index) => (
                <button
                  type="button"
                  key={example.name}
                  className="command-tab"
                  aria-pressed={selected === index}
                  aria-controls="connection-example"
                  onClick={() => {
                    setSelected(index);
                    setCopied(false);
                    setCopyError(false);
                  }}
                >
                  {example.name}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void copy()}
              aria-label={copied ? "Copied commands" : "Copy commands"}
              className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {copied ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Copy size={16} aria-hidden="true" />
              )}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </div>
          <div id="connection-example" className="px-5 py-6 sm:px-7 sm:py-8">
            <pre className="min-h-40 overflow-x-auto font-mono text-[12px] leading-8 sm:text-sm">
              <code>{current.code}</code>
            </pre>
            <p
              role="status"
              className="mt-6 border-t pt-5 text-xs leading-relaxed text-muted-foreground"
            >
              {copyError
                ? "Couldn’t copy. You can select the commands above."
                : copied
                  ? "Commands copied."
                  : current.note}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
