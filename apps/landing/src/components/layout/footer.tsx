import Link from "next/link";
import { OrchestratLogo } from "@/components/graphics/orchestrat-logo";
import { founder } from "@/lib/seo";
import { CookiePreferences } from "@/components/cookie-preferences";

export function Footer() {
  return (
    <footer className="site-container">
      <div className="flex flex-col justify-between gap-8 border-t py-10 lg:flex-row lg:items-center">
        <Link href="/" aria-label="Orchestrat home">
          <OrchestratLogo />
        </Link>
        <nav
          aria-label="Footer navigation"
          className="flex flex-wrap gap-x-7 gap-y-4 text-sm text-muted-foreground"
        >
          {[
            { href: "/about", label: "About" },
            { href: "/docs", label: "Docs" },
            { href: "/guides", label: "Guides" },
            { href: "/pricing", label: "Pricing" },
            { href: "/faq", label: "FAQ" }
          ].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="hover:text-primary-text"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
      <p className="pb-7 text-xs leading-6 text-muted-foreground">
        Built by{" "}
        <a href={founder.url} className="hover:text-primary-text">
          {founder.name}
        </a>{" "}
        ·{" "}
        <a
          href="mailto:arman@orchestrat.dev"
          className="hover:text-primary-text"
        >
          arman@orchestrat.dev
        </a>
      </p>
      <div className="flex flex-col justify-between gap-3 border-t py-7 text-xs text-muted-foreground sm:flex-row">
        <p>© {new Date().getFullYear()} Orchestrat. All rights reserved.</p>
        <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-3">
          <Link href="/terms" className="hover:text-primary-text">
            Terms of Service
          </Link>
          <Link href="/privacy" className="hover:text-primary-text">
            Privacy Policy
          </Link>
          <Link href="/privacy#cookies" className="hover:text-primary-text">
            Cookie information
          </Link>
          <CookiePreferences />
        </nav>
      </div>
    </footer>
  );
}
