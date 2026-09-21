import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found | Orchestrat",
  description:
    "This page could not be found. Return to Orchestrat or explore the documentation."
};

export default function NotFound() {
  return (
    <section className="site-container flex min-h-[65vh] flex-col justify-center py-20">
      <p className="mb-6 font-mono text-sm text-primary-text">
        404 / PAGE NOT FOUND
      </p>
      <h1 className="section-title max-w-3xl">This page is off the board.</h1>
      <p className="section-copy mt-6 max-w-lg">
        The link may have moved, or the page may no longer exist. Your next step
        is still here.
      </p>
      <div className="mt-9 flex flex-wrap gap-3">
        <Link className="button button-primary" href="/">
          Back to Orchestrat
        </Link>
        <Link className="button button-outline" href="/docs">
          Read the docs
        </Link>
      </div>
      <a
        className="text-link mt-7 self-start text-muted-foreground"
        href="mailto:arman@orchestrat.dev"
      >
        Report a broken link
      </a>
    </section>
  );
}
