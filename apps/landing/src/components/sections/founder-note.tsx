import { ArrowUpRight } from "lucide-react";
import { AgentMark, type AgentId } from "@/components/landing/agents";
import { OrchestratIcon } from "@/components/graphics/orchestrat-logo";
import { founder } from "@/lib/seo";

const crew: AgentId[] = ["claude", "codex"];

export function FounderNoteSection() {
  return (
    <section
      aria-labelledby="founder-heading"
      className="site-container section-space"
    >
      <div className="mx-auto grid max-w-5xl gap-10 rounded-3xl border bg-card/40 p-7 sm:p-12 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:items-center md:gap-14">
        <div>
          <h2
            id="founder-heading"
            className="text-3xl font-semibold tracking-[-0.03em] sm:text-4xl"
          >
            Hi, I’m Arman.
          </h2>
          <div className="mt-6 space-y-4 text-base leading-relaxed text-muted-foreground">
            <p>
              I build Orchestrat with Claude Code and Codex working side by side
              in the same repo. Before Orchestrat, they kept starting the same
              task, following yesterday’s plan, and waiting on me to carry
              context between terminals.
            </p>
            <p>
              So I gave them one place to check in: who owns what, what the plan
              says now, and what just changed. These days Orchestrat coordinates
              the agents that build Orchestrat.
            </p>
            <p>
              If you run more than one agent, I would love to hear how you work.
            </p>
          </div>
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3">
            <a
              href="mailto:arman@orchestrat.dev"
              className="text-link text-foreground"
            >
              arman@orchestrat.dev
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <a href={founder.url} className="text-link text-muted-foreground">
              {founder.name} on X
              <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          </div>
        </div>
        <div
          aria-hidden="true"
          className="relative mx-auto flex aspect-square w-full max-w-[280px] items-center justify-center"
        >
          <div className="absolute inset-0 rounded-full border border-dashed" />
          <div className="absolute inset-[18%] rounded-full border" />
          <OrchestratIcon className="size-20" />
          <span className="absolute top-[6%] left-[14%]">
            <AgentMark agent={crew[0]} className="size-14" />
          </span>
          <span className="absolute right-[6%] bottom-[18%]">
            <AgentMark agent={crew[1]} className="size-14" />
          </span>
          <span className="absolute bottom-[2%] left-[22%]">
            <AgentMark agent="you" className="size-11" />
          </span>
        </div>
      </div>
    </section>
  );
}
