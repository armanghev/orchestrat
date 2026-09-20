"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Menu, X } from "lucide-react";
import { OrchestratLogo } from "@/components/graphics/orchestrat-logo";

const links = [
  { label: "Workspace", href: "/#workspace" },
  { label: "How it works", href: "/#protocol" }
];

export function Navbar() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-50 bg-background/95 backdrop-blur-md">
      <nav
        aria-label="Main navigation"
        className="site-container"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            document.getElementById("menu-toggle")?.focus();
          }
        }}
      >
        <div className="flex h-20 items-center justify-between gap-4">
          <Link
            href="/"
            aria-label="Orchestrat home"
            onClick={() => setOpen(false)}
          >
            <OrchestratLogo />
          </Link>
          <div className="hidden items-center gap-8 md:flex">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-muted-foreground transition-colors hover:text-primary-text"
              >
                {link.label}
              </Link>
            ))}
          </div>
          <Link
            href="/#waitlist"
            className="button button-primary hidden min-h-9 px-4 md:inline-flex"
          >
            Join waitlist
          </Link>
          <button
            id="menu-toggle"
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-navigation"
            className="flex size-11 items-center justify-center rounded-md hover:bg-secondary md:hidden"
            onClick={() => setOpen(!open)}
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
        {open && (
          <div
            id="mobile-navigation"
            className="flex flex-col gap-1 border-t pb-5 pt-3 md:hidden"
          >
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-md px-3 py-3 text-sm text-muted-foreground hover:bg-secondary"
                onClick={() => setOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            <Link
              href="/#waitlist"
              className="button button-primary mt-2"
              onClick={() => setOpen(false)}
            >
              Join waitlist
              <ArrowRight size={16} />
            </Link>
          </div>
        )}
      </nav>
    </header>
  );
}
