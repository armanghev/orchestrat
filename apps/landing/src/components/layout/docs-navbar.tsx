"use client";

import Link from "next/link";
import { Menu, Search } from "lucide-react";
import { SidebarTrigger } from "fumadocs-ui/components/layout/sidebar";
import { useSearchContext } from "fumadocs-ui/provider";
import { OrchestratLogo } from "@/components/graphics/orchestrat-logo";
import { GitHubMark } from "@/components/graphics/github-mark";
import { siteLinks } from "@/components/layout/navbar";
import { githubUrl, quickstartHref } from "@/lib/links";

/**
 * The site navbar for the docs. It is fixed rather than sticky because the
 * docs layout offsets its sidebar and table of contents by --fd-nav-height.
 */
export function DocsNavbar() {
  const { enabled: searchEnabled, setOpenSearch } = useSearchContext();
  return (
    <header className="fixed inset-x-0 top-0 z-30 border-b bg-background/95 backdrop-blur-md on-root:[--fd-nav-height:80px]">
      <nav aria-label="Main navigation" className="site-container">
        <div className="grid h-20 grid-cols-[1fr_auto_1fr] items-center gap-4">
          <div className="col-start-1 flex items-center gap-2.5 justify-self-start text-lg tracking-tight">
            <Link href="/" aria-label="Orchestrat home">
              <OrchestratLogo />
            </Link>
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
            <Link
              href="/docs"
              className="text-muted-foreground transition-colors hover:text-primary-text"
            >
              Docs
            </Link>
          </div>
          <div className="col-start-2 hidden items-center gap-8 lg:flex">
            {siteLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={link.href === "/docs" ? "page" : undefined}
                className="text-sm text-muted-foreground transition-colors hover:text-primary-text aria-[current=page]:text-foreground"
              >
                {link.label}
              </Link>
            ))}
          </div>
          <div className="col-start-3 flex items-center justify-self-end gap-2">
            <div className="hidden items-center gap-2 md:flex">
              <a href={githubUrl} className="button button-ghost min-h-9 px-3">
                <GitHubMark />
                GitHub
              </a>
              <Link
                href={quickstartHref}
                className="button button-primary min-h-9 px-4"
              >
                Self-host it
              </Link>
            </div>
            <div className="flex items-center gap-1 md:hidden">
              {searchEnabled && (
                <button
                  type="button"
                  aria-label="Search docs"
                  className="flex size-11 items-center justify-center rounded-md hover:bg-secondary"
                  onClick={() => setOpenSearch(true)}
                >
                  <Search size={20} aria-hidden="true" />
                </button>
              )}
              <SidebarTrigger
                aria-label="Open docs menu"
                className="flex size-11 items-center justify-center rounded-md hover:bg-secondary"
              >
                <Menu size={20} aria-hidden="true" />
              </SidebarTrigger>
            </div>
          </div>
        </div>
      </nav>
    </header>
  );
}
