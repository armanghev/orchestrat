import Link from "next/link";
import { OrchestratLogo } from "@/components/graphics/orchestrat-logo";

export function Footer() {
  return (
    <footer className="site-container">
      <div className="flex flex-col justify-between gap-8 border-t py-10 sm:flex-row sm:items-center">
        <Link href="/" aria-label="Orchestrat home">
          <OrchestratLogo />
        </Link>
        <nav
          aria-label="Footer navigation"
          className="flex flex-wrap gap-x-7 gap-y-4 text-sm text-muted-foreground"
        >
          <Link href="/#workspace" className="hover:text-primary-text">
            Workspace
          </Link>
          <Link href="/#protocol" className="hover:text-primary-text">
            How it works
          </Link>
          <Link href="/#waitlist" className="hover:text-primary-text">
            Join waitlist
          </Link>
        </nav>
      </div>
      <div className="flex flex-col justify-between gap-3 border-t py-7 text-xs text-muted-foreground sm:flex-row">
        <p>© {new Date().getFullYear()} Orchestrat. All rights reserved.</p>
        <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-3">
          <Link href="/terms" className="hover:text-primary-text">
            Terms of Service
          </Link>
          <Link href="/privacy" className="hover:text-primary-text">
            Privacy Policy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
