"use client";

import { type FormEvent, useEffect, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Reveal } from "@/components/motion/reveal";

type WaitlistStatus =
  | "joined"
  | "invalid"
  | "unavailable"
  | "error"
  | null;

export function WaitlistCtaSection() {
  const [email, setEmail] = useState("");
  const [focus, setFocus] = useState(["tasks", "agents"]);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<WaitlistStatus>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const waitlist = params.get("waitlist") as WaitlistStatus;
    if (waitlist === "joined") {
      setSubmitted(true);
      setStatus("joined");
    } else if (
      waitlist === "unavailable" ||
      waitlist === "invalid" ||
      waitlist === "error"
    ) {
      setStatus(waitlist);
      setError(
        waitlist === "unavailable"
          ? "Waitlist storage is not configured in this environment. Your email was not saved."
          : waitlist === "invalid"
            ? "That email does not look valid. Please try again."
            : "We couldn't save your place. Please try again."
      );
    }
  }, []);

  const options = [
    { id: "tasks", label: "Task coordination" },
    { id: "agents", label: "Agent presence" },
    { id: "documents", label: "Shared documents" },
    { id: "activity", label: "Activity history" },
    { id: "mcp", label: "MCP" },
    { id: "api", label: "API & SDK" }
  ];

  function toggle(id: string) {
    setFocus((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    setStatus(null);

    try {
      const formData = new FormData();
      formData.set("email", email);
      const response = await fetch("/api/waitlist", {
        method: "POST",
        body: formData,
        headers: { Accept: "application/json" }
      });
      const result = (await response.json()) as { status?: string };

      if (result.status === "joined") {
        setSubmitted(true);
        setStatus("joined");
        return;
      }

      if (result.status === "unavailable") {
        setStatus("unavailable");
        setError(
          "Waitlist storage is not configured in this environment. Your email was not saved."
        );
        return;
      }

      if (result.status === "invalid") {
        setStatus("invalid");
        setError("That email does not look valid. Please try again.");
        return;
      }

      setStatus("error");
      setError("We couldn't save your place. Please try again.");
    } catch {
      setStatus("error");
      setError("We couldn't save your place. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section id="waitlist" className="py-20 md:py-28">
      <div className="max-w-container-lg mx-auto px-6">
        <Reveal yOffset={16}>
          <div className="max-w-2xl space-y-8">
            <div className="space-y-3">
              <p className="font-mono text-[11px] tracking-[0.14em] text-primary-text uppercase">
                Private early access
              </p>
              <h2 className="text-2xl leading-tight font-semibold tracking-tight text-foreground sm:text-3xl">
                Give your agents one place to coordinate.
              </h2>
              <p className="max-w-lg text-sm leading-relaxed font-light text-muted-foreground">
                Join the private orchestrat waitlist. We&apos;ll send an invite
                when early access is ready for your workspace.
              </p>
            </div>

            <AnimatePresence mode="wait">
              {!submitted ? (
                <motion.form
                  key="form"
                  action="/api/waitlist"
                  method="post"
                  initial={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onSubmit={submit}
                  className="space-y-6"
                >
                  <div className="space-y-2.5">
                    <p className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
                      What do you want to coordinate?
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {options.map((option) => {
                        const selected = focus.includes(option.id);
                        return (
                          <button
                            type="button"
                            aria-pressed={selected}
                            key={option.id}
                            onClick={() => toggle(option.id)}
                            className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-[12px] transition-colors ${
                              selected
                                ? "border-border bg-accent text-accent-foreground"
                                : "border-border/60 text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            {selected && (
                              <Check className="h-3 w-3" strokeWidth={2} />
                            )}
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <input
                    type="text"
                    name="company"
                    tabIndex={-1}
                    autoComplete="off"
                    className="hidden"
                    aria-hidden
                  />

                  <div className="flex max-w-lg flex-col gap-3 sm:flex-row">
                    <input
                      type="email"
                      name="email"
                      aria-label="Email address"
                      aria-describedby={error ? "waitlist-error" : undefined}
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@company.com"
                      required
                      className="flex-1 rounded-md border border-input bg-muted/50 px-4 py-2.5 text-sm font-light text-foreground transition-colors placeholder:text-muted-foreground focus:border-ring focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={loading}
                      className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium whitespace-nowrap text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {loading ? (
                        "Joining..."
                      ) : (
                        <>
                          Join waitlist{" "}
                          <ArrowRight className="h-4 w-4" strokeWidth={1.5} />
                        </>
                      )}
                    </button>
                  </div>

                  {error && (
                    <p
                      id="waitlist-error"
                      role="alert"
                      className={`text-sm ${
                        status === "unavailable"
                          ? "text-warning"
                          : "text-destructive"
                      }`}
                    >
                      {error}
                    </p>
                  )}

                  {status === "unavailable" && (
                    <p className="font-mono text-[11px] text-muted-foreground">
                      Local/dev tip: set SUPABASE_URL and
                      SUPABASE_PUBLISHABLE_KEY to enable waitlist writes.
                    </p>
                  )}
                </motion.form>
              ) : (
                <motion.div
                  key="success"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="space-y-2 rounded-lg border border-border bg-card px-5 py-4"
                >
                  <p className="text-sm font-medium text-foreground">
                    You&apos;re on the orchestrat waitlist.
                  </p>
                  <p className="text-sm font-light text-muted-foreground">
                    We saved your place for{" "}
                    <span className="text-secondary-foreground">{email}</span>.
                    We&apos;ll send an invite when early access is ready.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
