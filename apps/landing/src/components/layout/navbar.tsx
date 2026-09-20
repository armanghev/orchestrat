"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { OrchestratLogo } from "@/components/graphics/orchestrat-logo";
import { Menu, X } from "lucide-react";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const links = [
    { label: "Workspace", href: "/#workspace" },
    { label: "Protocol", href: "/#protocol" }
  ];

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 border-b transition-colors duration-200 ${
        scrolled || mobileOpen
          ? "border-border bg-background/90 backdrop-blur-md"
          : "border-transparent bg-background/40 backdrop-blur-sm"
      }`}
    >
      <nav className="max-w-container-lg mx-auto flex h-14 items-center justify-between gap-4 px-6">
        <Link href="/" onClick={() => setMobileOpen(false)}>
          <OrchestratLogo />
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase transition-colors hover:text-foreground"
            >
              {l.label}
            </Link>
          ))}
          <Link
            href="/#waitlist"
            className="rounded-md bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Waitlist
          </Link>
        </div>

        <button
          className="text-muted-foreground transition-colors hover:text-foreground md:hidden"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle menu"
        >
          {mobileOpen ? (
            <X className="h-5 w-5" strokeWidth={1.5} />
          ) : (
            <Menu className="h-5 w-5" strokeWidth={1.5} />
          )}
        </button>
      </nav>

      {mobileOpen && (
        <div className="border-t border-border px-6 py-4 md:hidden">
          <div className="flex flex-col gap-3">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="font-mono text-xs tracking-wider text-muted-foreground uppercase"
                onClick={() => setMobileOpen(false)}
              >
                {l.label}
              </Link>
            ))}
            <Link
              href="/#waitlist"
              onClick={() => setMobileOpen(false)}
              className="mt-1 rounded-md bg-primary px-4 py-2.5 text-center text-sm font-medium text-primary-foreground"
            >
              Waitlist
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

export default Navbar;
