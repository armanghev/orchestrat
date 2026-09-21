import { HeroSection } from "@/components/sections/hero";
import { CliPreviewSection } from "@/components/sections/cli-preview";
import { WaitlistCtaSection } from "@/components/sections/waitlist-cta";
import { SharedStatePreviewSection } from "@/components/sections/shared-state-preview";
import Link from "next/link";
import { StructuredData } from "@/components/structured-data";
import { faqs } from "@/lib/content";
import { homeStructuredData, pageMetadata, siteDescription } from "@/lib/seo";

export const metadata = pageMetadata(
  "Coordinate your AI coding agents",
  siteDescription,
  ""
);

export default function Home() {
  return (
    <>
      <StructuredData data={homeStructuredData} />
      <HeroSection />
      <SharedStatePreviewSection />
      <CliPreviewSection />
      <section
        aria-labelledby="answers-heading"
        className="site-container section-space"
      >
        <div className="grid gap-10 lg:grid-cols-[1fr_1.3fr] lg:gap-20">
          <div>
            <p className="mb-5 text-sm text-primary-text">
              A few things to know
            </p>
            <h2 id="answers-heading" className="section-title">
              Your questions.
              <br />
              Shared answers.
            </h2>
            <div className="mt-8 flex flex-wrap gap-x-7 gap-y-3">
              <Link className="text-link" href="/docs">
                Read the docs ↗
              </Link>
              <Link className="text-link" href="/guides">
                Explore the guides ↗
              </Link>
              <Link className="text-link" href="/faq">
                All questions ↗
              </Link>
            </div>
          </div>
          <div className="divide-y border-y">
            {faqs.slice(0, 4).map((faq) => (
              <details key={faq.heading} className="py-5">
                <summary className="cursor-pointer py-2 pr-4 text-base font-medium">
                  {faq.heading}
                </summary>
                <p className="mt-3 max-w-xl text-sm leading-7 text-muted-foreground">
                  {faq.paragraphs[0]}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>
      <WaitlistCtaSection />
    </>
  );
}
