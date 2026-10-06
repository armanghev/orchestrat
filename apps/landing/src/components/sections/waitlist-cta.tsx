"use client";

import { type FormEvent, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { OrchestratIcon } from "@/components/graphics/orchestrat-logo";

export function WaitlistCtaSection() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const formData = new FormData(event.currentTarget);
      const response = await fetch("/api/waitlist", {
        method: "POST",
        body: formData,
        headers: { Accept: "application/json" }
      });
      const result = await response.json();
      if (!response.ok || result.status !== "joined")
        throw new Error("Waitlist request was not accepted.");
      setSubmitted(true);
    } catch {
      setError("We couldn't save your place. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section
      aria-labelledby="waitlist-heading"
      className="site-container section-space"
    >
      <div
        id="waitlist"
        className="relative mx-auto flex max-w-3xl flex-col items-center text-center"
      >
        <div aria-hidden="true" className="hero-glow inset-x-0 top-0 h-full" />
        <OrchestratIcon className="mb-9 size-16" />
        <h2 id="waitlist-heading" className="closing-heading">
          Less chasing.
          <br />
          <span className="text-muted-foreground">More building.</span>
        </h2>
        <p className="section-copy mt-6 max-w-md">
          Join the private waitlist. We’ll send an invite when early access is
          ready for your workspace.
        </p>
        <div className="mt-10 w-full max-w-md text-left">
          {submitted ? (
            <div role="status" className="rounded-lg border bg-card p-7">
              <Check
                className="mb-4 text-success"
                size={24}
                aria-hidden="true"
              />
              <h3 className="text-lg font-medium">
                You&apos;re on the orchestrat waitlist.
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                We saved your place for{" "}
                <span className="break-all text-foreground">{email}</span>.
                We&apos;ll send an invite when early access is ready.
              </p>
            </div>
          ) : (
            <form
              action="/api/waitlist"
              method="post"
              onSubmit={submit}
              className="space-y-4"
              aria-busy={loading}
            >
              <label htmlFor="waitlist-email" className="block text-sm">
                Email address
              </label>
              <div className="flex flex-col gap-2 rounded-xl border border-input bg-card/60 p-2 sm:flex-row">
                <input
                  id="waitlist-email"
                  type="email"
                  name="email"
                  autoComplete="email"
                  maxLength={254}
                  aria-describedby={`waitlist-note${error ? " waitlist-error" : ""}`}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@company.com"
                  required
                  disabled={loading}
                  className="min-h-12 w-full min-w-0 flex-1 rounded-lg bg-transparent px-3 text-sm placeholder:text-muted-foreground"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="button button-primary min-h-12 shrink-0"
                >
                  {loading ? "Joining…" : "Join the waitlist"}
                  {!loading && <ArrowRight size={16} aria-hidden="true" />}
                </button>
              </div>
              <div className="hidden" aria-hidden="true">
                <label htmlFor="waitlist-company">Company</label>
                <input
                  id="waitlist-company"
                  name="company"
                  tabIndex={-1}
                  autoComplete="off"
                />
              </div>
              {error && (
                <p
                  id="waitlist-error"
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {error}
                </p>
              )}
              <p
                id="waitlist-note"
                className="text-center text-xs leading-6 text-muted-foreground"
              >
                By joining, you’re requesting Orchestrat early-access emails.{" "}
                <a
                  href="mailto:arman@orchestrat.dev?subject=Remove%20me%20from%20the%20waitlist"
                  className="underline underline-offset-4 hover:text-primary-text"
                >
                  Request removal anytime
                </a>
                . Read our{" "}
                <Link
                  href="/privacy"
                  className="underline underline-offset-4 hover:text-primary-text"
                >
                  Privacy Policy
                </Link>
                .
              </p>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
