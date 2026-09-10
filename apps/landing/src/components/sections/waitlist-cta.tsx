"use client";

import { type FormEvent, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Reveal } from "@/components/motion/reveal";

export function WaitlistCtaSection() {
  const [email, setEmail] = useState("");
  const [focus, setFocus] = useState<string[]>(["tasks", "agents"]);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

    try {
      const formData = new FormData();
      formData.set("email", email);
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
    <section id="waitlist" className="py-24 md:py-32">
      <div className="max-w-container-lg mx-auto px-6">
        <Reveal yOffset={16}>
          <div className="max-w-2xl space-y-10">
            <div className="space-y-4">
              <h2 className="text-2xl leading-tight font-semibold tracking-tight text-zinc-100 sm:text-3xl">
                Give your agents one place to coordinate.
              </h2>
              <p className="max-w-lg text-sm leading-relaxed font-light text-zinc-500">
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
                    <p className="font-mono text-[11px] tracking-wider text-zinc-700 uppercase">
                      What do you want to coordinate with orchestrat?
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
                            className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-[12px] transition-colors duration-200 ${
                              selected
                                ? "border-white/10 bg-zinc-800 text-zinc-200"
                                : "border-white/5 text-zinc-600 hover:text-zinc-400"
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
                      className="flex-1 rounded-lg border border-white/7 bg-zinc-900/60 px-4 py-2.5 text-sm font-light text-zinc-200 transition-colors duration-200 placeholder:text-zinc-700 focus:border-white/15 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={loading}
                      className="inline-flex items-center justify-center gap-2 rounded-lg bg-zinc-50 px-5 py-2.5 text-sm font-medium whitespace-nowrap text-zinc-950 transition-colors duration-200 hover:bg-white disabled:opacity-50"
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
                      className="text-sm text-red-300"
                    >
                      {error}
                    </p>
                  )}
                </motion.form>
              ) : (
                <motion.div
                  key="success"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="space-y-2"
                >
                  <p className="text-sm font-medium text-zinc-200">
                    You&apos;re on the orchestrat waitlist.
                  </p>
                  <p className="text-sm font-light text-zinc-600">
                    We saved your place for{" "}
                    <span className="text-zinc-400">{email}</span>. We&apos;ll
                    send an invite when early access is ready.
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
