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
    <section aria-labelledby="waitlist-heading" className="site-container">
      <div className="section-space grid gap-10 lg:py-24 md:grid-cols-[1.35fr_1fr] md:items-center md:gap-20">
        <div id="waitlist">
          <OrchestratIcon className="mb-7 size-12" />
          <h2 id="waitlist-heading" className="closing-heading">
            Less chasing.
            <br />
            <span className="text-muted-foreground">More building.</span>
          </h2>
        </div>
        <div>
          <p className="section-copy mb-7 max-w-lg">
            Join the private waitlist. We’ll send an invite when early access is
            ready for your workspace.
          </p>
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
              <div className="space-y-2.5">
                <label htmlFor="waitlist-email" className="block text-sm">
                  Email address
                </label>
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
                  className="min-h-12 w-full min-w-0 rounded-md border border-input bg-background px-4 text-sm placeholder:text-muted-foreground"
                />
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
              <button
                type="submit"
                disabled={loading}
                className="button button-primary min-h-12 w-full"
              >
                {loading ? "Joining…" : "Join the waitlist"}
                {!loading && <ArrowRight size={16} aria-hidden="true" />}
              </button>
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
