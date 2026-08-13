import Link from "next/link";
import {
  OrchestratIcon,
  OrchestratLogo
} from "@/components/graphics/orchestrat-logo";

export function Footer() {
  return (
    <footer className="border-t border-white/6 bg-zinc-950">
      <div className="max-w-container-lg mx-auto px-6 py-16">
        <div className="mb-16 grid grid-cols-1 gap-12 md:grid-cols-5">
          <div className="flex flex-col gap-6 md:col-span-2">
            <div>
              <OrchestratLogo />
              <p className="mt-4 max-w-sm text-xs leading-relaxed font-light text-zinc-500">
                orchestrat gives humans and autonomous agents one shared place
                to coordinate work.
              </p>
            </div>
          </div>

          <div>
            <h3 className="mb-4 font-mono text-xs font-medium tracking-wider text-zinc-300 uppercase">
              Coordination
            </h3>
            <ul className="space-y-3">
              {[
                "Tasks & claims",
                "Agent sessions",
                "Documents",
                "Messages",
                "Activity history",
                "Human review"
              ].map((item) => (
                <li key={item}>
                  <Link
                    href={
                      item === "Activity history" || item === "Human review"
                        ? "#control"
                        : "#workspace"
                    }
                    className="text-xs font-light text-zinc-500 transition-colors hover:text-zinc-300"
                  >
                    {item}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="mb-4 font-mono text-xs font-medium tracking-wider text-zinc-300 uppercase">
              Product
            </h3>
            <ul className="space-y-3">
              <li>
                <Link
                  href="#protocol"
                  className="text-xs font-light text-zinc-500 transition-colors hover:text-zinc-300"
                >
                  MCP server
                </Link>
              </li>
              <li>
                <Link
                  href="#workspace"
                  className="text-xs font-light text-zinc-500 transition-colors hover:text-zinc-300"
                >
                  Task claims
                </Link>
              </li>
              <li>
                <Link
                  href="#workspace"
                  className="text-xs font-light text-zinc-500 transition-colors hover:text-zinc-300"
                >
                  Shared documents
                </Link>
              </li>
              <li>
                <Link
                  href="#control"
                  className="text-xs font-light text-zinc-500 transition-colors hover:text-zinc-300"
                >
                  Activity stream
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="mb-4 font-mono text-xs font-medium tracking-wider text-zinc-300 uppercase">
              Connections
            </h3>
            <ul className="space-y-3">
              {[
                "MCP",
                "Hooks",
                "REST API",
                "Local bridge",
                "Markdown documents",
                "Realtime events"
              ].map((item) => (
                <li key={item}>
                  <span className="text-xs font-light text-zinc-500">
                    {item}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex flex-col items-center justify-between gap-4 border-t border-white/6 pt-8 font-mono text-xs text-zinc-600 md:flex-row">
          <p>
            &copy; {new Date().getFullYear()} Orchestrat. All rights reserved.
          </p>
          <p className="flex items-center gap-1">
            Coordination first. Humans in control.
            <OrchestratIcon className="text-zinc-300" />
          </p>
          <div className="flex items-center gap-6">
            <span>Private early access</span>
            <span>orchestrat.dev</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
