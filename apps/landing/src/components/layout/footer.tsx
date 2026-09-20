import Link from "next/link";
import {
  OrchestratIcon,
  OrchestratLogo
} from "@/components/graphics/orchestrat-logo";

export function Footer() {
  return (
    <footer className="border-t border-border bg-rail">
      <div className="max-w-container-lg mx-auto px-6 py-14">
        <div className="mb-12 grid grid-cols-1 gap-10 md:grid-cols-4">
          <div className="md:col-span-2">
            <OrchestratLogo />
            <p className="mt-4 max-w-sm text-xs leading-relaxed font-light text-muted-foreground">
              A coordination plane for humans and autonomous agents — shared
              tasks, exclusive claims, project knowledge, and activity. Not an
              agent runtime.
            </p>
          </div>

          <div>
            <h3 className="mb-3 font-mono text-[10px] font-medium tracking-[0.14em] text-foreground uppercase">
              Surfaces
            </h3>
            <ul className="space-y-2.5">
              {[
                { label: "Workspace", href: "/#workspace" },
                { label: "Protocol", href: "/#protocol" },
                { label: "Workflow", href: "/#workflow" },
                { label: "Waitlist", href: "/#waitlist" }
              ].map((item) => (
                <li key={item.label}>
                  <Link
                    href={item.href}
                    className="text-xs font-light text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="mb-3 font-mono text-[10px] font-medium tracking-[0.14em] text-foreground uppercase">
              Protocol
            </h3>
            <ul className="space-y-2.5">
              {["MCP", "Hooks", "REST API", "Local bridge"].map((item) => (
                <li key={item}>
                  <span className="font-mono text-xs text-muted-foreground">
                    {item}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex flex-col items-start justify-between gap-4 border-t border-border pt-6 font-mono text-[11px] text-muted-foreground md:flex-row md:items-center">
          <p>
            &copy; {new Date().getFullYear()} Orchestrat. All rights reserved.
          </p>
          <p className="flex items-center gap-1.5">
            Coordination plane
            <OrchestratIcon className="text-primary-text" />
            humans in control
          </p>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-3">
            <Link
              href="/terms"
              className="transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              Terms of Service
            </Link>
            <Link
              href="/privacy"
              className="transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            >
              Privacy Policy
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
