"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Menu, X } from "lucide-react";
import { OrchestratLogo } from "@/components/graphics/orchestrat-logo";

const links = [
  { label: "Workspace", href: "/#workspace" },
  { label: "How it works", href: "/#protocol" },
  { label: "Docs", href: "/docs" },
  { label: "Guides", href: "/guides" }
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
            className="group relative flex size-11 items-center justify-center rounded-md hover:bg-secondary md:hidden"
            onClick={() => setOpen((current) => !current)}
          >
            <Menu
              size={20}
              aria-hidden="true"
              className="absolute transition-[transform,opacity] duration-200 ease-out group-aria-expanded:rotate-90 group-aria-expanded:opacity-0"
            />
            <X
              size={20}
              aria-hidden="true"
              className="absolute -rotate-90 opacity-0 transition-[transform,opacity] duration-200 ease-out group-aria-expanded:rotate-0 group-aria-expanded:opacity-100"
            />
          </button>
        </div>
        <div
          id="mobile-navigation"
          data-open={open}
          aria-hidden={!open}
          inert={!open}
          className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] data-[open=true]:grid-rows-[1fr] data-[open=true]:opacity-100 md:hidden"
        >
          <div className="min-h-0 overflow-hidden">
            <div className="flex flex-col gap-1 border-t pb-5 pt-3">
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
          </div>
        </div>
      </nav>
    </header>
  );
}
