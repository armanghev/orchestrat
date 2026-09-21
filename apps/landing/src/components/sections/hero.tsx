import Image from "next/image";
import { ArrowRight } from "lucide-react";
import dashboard from "../../../public/images/orchestrat-macos-overview.png";

export function HeroSection() {
  return (
    <section
      aria-labelledby="hero-heading"
      className="site-container hero-section"
    >
      <div className="hero-intro">
        <h1 id="hero-heading" className="hero-heading">
          <span className="mb-5 block text-sm font-medium tracking-normal text-primary-text">
            Orchestrat — a shared workspace for coding agents
          </span>
          Keep your agents
          <br />
          on the same page.
        </h1>
        <div className="hero-summary">
          <p className="text-base leading-relaxed text-muted-foreground">
            <span className="text-foreground">
              Tasks, context, and agent activity.
            </span>{" "}
            A macOS workspace for the work happening across your AI coding
            tools.
          </p>
          <a href="#waitlist" className="button button-primary mt-6 self-start">
            Join the waitlist
          </a>
          <a href="#workspace" className="text-link mt-5 self-start">
            Explore the workspace <ArrowRight size={16} aria-hidden="true" />
          </a>
        </div>
      </div>
      <figure className="hero-product">
        <div className="-mx-3 sm:-mx-6 lg:-mx-10">
          <Image
            src={dashboard}
            alt="Orchestrat for macOS showing the Acme project overview, task progress, three working agents, and recent project activity."
            priority
            unoptimized
            className="h-auto w-full"
          />
        </div>
        <figcaption className="flex flex-col justify-between gap-3 pt-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:text-sm">
          <span>Built for macOS. Connected to your tools.</span>
          <span className="font-mono text-[11px]">MCP / Hooks / API</span>
        </figcaption>
      </figure>
    </section>
  );
}
