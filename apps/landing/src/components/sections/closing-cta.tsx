import { OrchestratIcon } from "@/components/graphics/orchestrat-logo";
import { CtaLinks } from "@/components/cta-links";

export function ClosingCtaSection() {
  return (
    <section
      aria-labelledby="closing-heading"
      className="site-container section-space"
    >
      <div className="relative mx-auto flex max-w-3xl flex-col items-center text-center">
        <div aria-hidden="true" className="hero-glow inset-x-0 top-0 h-full" />
        <OrchestratIcon className="mb-9 size-16" />
        <h2 id="closing-heading" className="closing-heading">
          Less chasing.
          <br />
          <span className="text-muted-foreground">More building.</span>
        </h2>
        <p className="section-copy mt-6 max-w-md">
          Free to self-host. Docker Compose starts the server and Postgres, and
          one CLI command connects your agents.
        </p>
        <CtaLinks className="mt-10 justify-center" />
      </div>
    </section>
  );
}
