"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { OrchestratLogo } from "@/components/graphics/orchestrat-logo";
import { ScrollProgress } from "@/components/motion/scroll-progress";
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
    { label: "Workspace", href: "#workspace" },
    { label: "Protocol", href: "#protocol" },
    { label: "Control", href: "#control" }
  ];

  return (
    <>
      <ScrollProgress />
      <nav
        className={`fixed left-1/2 z-50 flex -translate-x-1/2 flex-col justify-center transition-all duration-300 ${
          mobileOpen
            ? "top-3 w-[calc(100%-2rem)] rounded-2xl border border-white/10 bg-zinc-950/95 px-6 py-4 shadow-2xl backdrop-blur-xl"
            : scrolled
              ? "top-3 h-12 w-[calc(100%-2rem)] max-w-5xl rounded-[24px] border border-white/10 bg-zinc-950/75 px-6 shadow-lg shadow-black/40 backdrop-blur-xl"
              : "max-w-container-lg top-5 h-14 w-[calc(100%-2rem)] rounded-[28px] border border-white/6 bg-zinc-950/40 px-6 backdrop-blur-md"
        }`}
      >
        <div className="flex h-full w-full items-center justify-between">
          {/* Left: Logo */}
          <Link href="/" onClick={() => setMobileOpen(false)}>
            <OrchestratLogo />
          </Link>

          {/* Right: CTA */}
          <div className="hidden items-center gap-4 md:flex">
            <Link
              href="#waitlist"
              className="rounded-full bg-zinc-50 px-4 py-1.5 text-[13px] font-medium text-zinc-950 transition-colors duration-200 hover:bg-white"
            >
              Join waitlist
            </Link>
          </div>

          {/* Mobile toggle */}
          <button
            className="text-zinc-500 transition-colors hover:text-zinc-200 md:hidden"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? (
              <X className="h-5 w-5" strokeWidth={1.5} />
            ) : (
              <Menu className="h-5 w-5" strokeWidth={1.5} />
            )}
          </button>
        </div>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="mt-4 flex w-full flex-col gap-4 border-t border-white/6 pt-4 md:hidden">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="py-1 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
                onClick={() => setMobileOpen(false)}
              >
                {l.label}
              </Link>
            ))}
            <div className="border-t border-white/6 pt-2">
              <Link
                href="#waitlist"
                onClick={() => setMobileOpen(false)}
                className="block w-full rounded-full bg-zinc-50 px-4 py-2.5 text-center text-sm font-medium text-zinc-950"
              >
                Join waitlist
              </Link>
            </div>
          </div>
        )}
      </nav>
    </>
  );
}

export default Navbar;
