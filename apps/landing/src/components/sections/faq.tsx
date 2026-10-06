import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Eyebrow } from "@/components/landing/agents";
import { faqs } from "@/lib/content";

export function FaqSection() {
  return (
    <section
      aria-labelledby="answers-heading"
      className="site-container section-space"
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-20">
        <div>
          <Eyebrow>A few things to know</Eyebrow>
          <h2 id="answers-heading" className="section-title">
            Your questions.
            <br />
            <span className="text-muted-foreground">Shared answers.</span>
          </h2>
          <div className="mt-8 flex flex-wrap gap-x-7 gap-y-3">
            <Link className="text-link" href="/docs">
              Read the docs <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
            <Link className="text-link" href="/guides">
              Explore the guides <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
            <Link className="text-link" href="/faq">
              All questions <ArrowUpRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </div>
        <div className="divide-y border-y">
          {faqs.slice(0, 5).map((faq) => (
            <details key={faq.heading} className="faq-item group">
              <summary>
                {faq.heading}
                <span aria-hidden="true" className="faq-icon" />
              </summary>
              <p className="max-w-xl pb-6 text-sm leading-7 text-muted-foreground sm:text-base">
                {faq.paragraphs[0]}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
