"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Eyebrow, WindowBar } from "@/components/landing/agents";

const examples = [
  {
    name: "CLI",
    code: "npx @orchestrat/cli setup --server http://localhost:8801\norchestrat status",
    note: "Point setup at your server once. Keep working in the tools you know."
  },
  {
    name: "MCP",
    code: "orchestrat mcp --integration codex\n\n# Or connect Claude Code\norchestrat mcp --integration claude-code",
    note: "The local bridge gives your agents access to shared project state."
  },
  {
    name: "API",
    code: 'curl "http://localhost:8801/api/v1/projects/$PROJECT_ID/tasks" \\\n  -H "Authorization: Bearer $ACCESS_TOKEN"',
    note: "Use your server URL, project ID, and access token to read project tasks."
  }
];
const steps = [
  {
    title: "Run setup in your project",
    text: "One npx command, pointed at your server. It detects your installed coding tools and previews the config it will manage."
  },
  {
    title: "Approve it in the browser",
    text: "Your Orchestrat dashboard confirms the connection, then setup asks which project to use and creates an agent identity for each tool."
  },
  {
    title: "Restart your agents",
    text: "They can now read tasks, claim work, update documents, and take part in project chats. Follow along in the dashboard."
  }
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
      id="setup"
      aria-labelledby="protocol-heading"
      className="site-container section-space"
    >
      <div className="integration-grid">
        <div>
          <Eyebrow>Do I have to switch tools?</Eyebrow>
          <h2 id="protocol-heading" className="section-title">
            Your tools stay.
            <br />
            <span className="text-muted-foreground">The context connects.</span>
          </h2>
          <p className="section-copy mt-6 max-w-md">
            Keep using the coding tools you already pay for. Orchestrat connects
            them through MCP, lifecycle hooks, and an API.
          </p>
          <ol className="mt-10 space-y-7">
            {steps.map((step, index) => (
              <li key={step.title} className="flex gap-5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full border font-mono text-xs text-primary-text">
                  {index + 1}
                </span>
                <div>
                  <p className="font-medium">{step.title}</p>
                  <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
                    {step.text}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div className="command-panel lg:mt-4">
          <WindowBar title="Terminal · ~/acme" />
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
            {examples.map((example, index) => (
              <pre
                key={example.name}
                hidden={selected !== index}
                className="min-h-44 overflow-x-auto font-mono text-[12px] leading-8 sm:text-sm"
              >
                <code>
                  {example.code.split("\n").map((line, lineIndex) => (
                    <span key={lineIndex} className="block">
                      {line.startsWith("#") ? (
                        <span className="text-muted-foreground">{line}</span>
                      ) : line.startsWith(" ") ? (
                        line
                      ) : line ? (
                        <>
                          <span
                            aria-hidden="true"
                            className="mr-3 text-primary-text select-none"
                          >
                            $
                          </span>
                          {line}
                        </>
                      ) : (
                        "\u00a0"
                      )}
                    </span>
                  ))}
                </code>
              </pre>
            ))}
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
