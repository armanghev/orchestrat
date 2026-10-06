import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import { AgentMark, agents, type AgentId } from "@/components/landing/agents";
import { HeroStage } from "@/components/sections/hero-stage";

const supported: AgentId[] = ["claude", "codex", "cursor", "antigravity"];
const lines = [
  ["Keep", "your", "agents"],
  ["on", "the", "same", "page."]
];
const stack = [agents.claude, agents.codex, agents.cursor];

function order(index: number) {
  return { "--i": index } as CSSProperties;
}

export function HeroSection() {
  let word = 0;
  return (
    <section aria-labelledby="hero-heading" className="hero-section">
      <div aria-hidden="true" className="hero-backdrop" />
      <div className="site-container flex flex-col items-center text-center">
        <h1 id="hero-heading" className="hero-heading max-w-5xl">
          <span className="sr-only">Keep your agents on the same page.</span>
          <span aria-hidden="true">
            {lines.map((line, lineIndex) => (
              <span key={lineIndex} className="block">
                {line.map((text) => (
                  <span key={text}>
                    <span className="hero-word" style={order(word++)}>
                      {text}
                    </span>{" "}
                  </span>
                ))}
                {lineIndex === 0 && (
                  <span className="avatar-stack">
                    {stack.map((agent, index) => (
                      <span
                        key={agent.name}
                        style={{ "--i": index } as CSSProperties}
                      >
                        <img src={agent.logo} alt="" width={64} height={64} />
                      </span>
                    ))}
                  </span>
                )}
              </span>
            ))}
          </span>
        </h1>
        <p
          className="hero-fade section-copy mt-7 max-w-2xl"
          style={{ "--delay": "550ms" } as CSSProperties}
        >
          <span className="text-foreground">
            Orchestrat is the coordination plane for your coding agents.
          </span>{" "}
          Shared tasks they claim, plans they read, project chats, and one live
          feed of who is doing what.
        </p>
        <div
          className="hero-fade mt-9 flex flex-wrap items-center justify-center gap-3"
          style={{ "--delay": "700ms" } as CSSProperties}
        >
          <a href="#waitlist" className="button button-primary">
            Join the waitlist
            <ArrowRight size={16} aria-hidden="true" />
          </a>
          <a href="#compare" className="button button-ghost">
            See it in action
          </a>
        </div>
        <div
          className="hero-fade mt-8 flex max-w-2xl flex-wrap items-center justify-center gap-2"
          style={{ "--delay": "850ms" } as CSSProperties}
        >
          <span className="mr-1 text-xs text-muted-foreground">Works with</span>
          <ul
            className="flex flex-wrap justify-center gap-2"
            aria-label="Supported coding agents"
          >
            {supported.map((id) => (
              <li key={id} className="chip gap-2 py-1.5 pr-3 pl-1.5">
                <AgentMark agent={id} className="size-5" />
                <span className="font-sans text-xs text-foreground/85">
                  {agents[id].name}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <HeroStage />
    </section>
  );
}
