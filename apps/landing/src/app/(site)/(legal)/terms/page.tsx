import Link from "next/link";
import { licenseUrl } from "@/lib/links";
import { founder, pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata(
  "Terms of Service",
  "Terms for using the orchestrat.dev website and documentation. The Orchestrat software is governed by the Elastic License 2.0.",
  "/terms"
);

export default function TermsPage() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p className="text-xs">
        Last updated <time dateTime="2026-10-14">October 14, 2026</time>
      </p>
      <p>
        These terms govern your use of the orchestrat.dev website, including its
        guides and documentation (the “Website”). The Website is operated by{" "}
        <a href={founder.url}>{founder.name}</a> (“we,” “us”). By using the
        Website, you agree to these terms. If you do not agree, do not use the
        Website.
      </p>

      <section>
        <h2>1. The software is governed by its license</h2>
        <p>
          These terms do not cover the Orchestrat software. The software is
          source-available under the{" "}
          <a href={licenseUrl}>Elastic License 2.0</a>, and that license alone
          governs how you may use, modify, and distribute it. In short, you may
          use, modify, and self-host it and build it into your own products, but
          you may not offer it to others as a hosted or managed service or
          remove its license notices. The license text controls; this summary
          does not change it.
        </p>
        <p>
          When you run Orchestrat, you operate that instance. You are
          responsible for its security, the accounts on it, the data it holds,
          and the coding tools and agents you connect to it. We do not operate
          or have access to self-hosted instances.
        </p>
      </section>

      <section>
        <h2>2. Documentation and content</h2>
        <p>
          We publish documentation and guides to help you run Orchestrat. Some
          pages describe features that are still being built and are marked as
          drafts. Documentation may change and may contain errors, so check it
          against the source and your own setup before relying on it.
        </p>
        <p>
          The Orchestrat name and logo are not licensed under the Elastic
          License 2.0. Other product names and logos shown on the Website, such
          as those of supported coding tools, belong to their respective owners
          and are used only to identify those tools.
        </p>
      </section>

      <section>
        <h2>3. Acceptable use</h2>
        <p>You must not use the Website to:</p>
        <ul>
          <li>Break the law or infringe another person’s rights.</li>
          <li>
            Disrupt or overload the Website, or try to access systems you are
            not authorized to access.
          </li>
          <li>Distribute malware or send spam.</li>
        </ul>
        <p>
          If you find a security issue in the Website or the software, please
          report it privately rather than exploiting or disclosing it.
        </p>
      </section>

      <section>
        <h2>4. Third-party services</h2>
        <p>
          The Website links to services we do not operate, such as GitHub, the
          npm registry, and the coding tools Orchestrat works with. Those
          services have their own terms and privacy practices. We are not
          responsible for their content or availability.
        </p>
      </section>

      <section>
        <h2>5. Disclaimers and liability</h2>
        <p>
          To the extent permitted by applicable law, the Website and its content
          are provided “as is” and “as available,” without warranties of
          merchantability, fitness for a particular purpose, or
          non-infringement. The software’s own warranty disclaimer and
          limitation of liability are in its license.
        </p>
        <p>
          To the extent permitted by applicable law, we are not liable for
          indirect or consequential losses, lost profits, or lost business
          opportunities arising from your use of the Website. Nothing in these
          terms excludes liability that cannot lawfully be excluded, including
          for fraud or willful misconduct, or limits your mandatory consumer
          rights.
        </p>
      </section>

      <section>
        <h2>6. Changes to these terms</h2>
        <p>
          We may update these terms as the Website evolves. We will post the
          updated version here with a new date. Your continued use of the
          Website after an update takes effect means you accept the updated
          terms. Our <Link href="/privacy">Privacy Policy</Link> describes how
          the Website handles personal information.
        </p>
      </section>

      <section>
        <h2>7. Contact</h2>
        <p>
          Questions about these terms can be sent to{" "}
          <a href={founder.url}>{founder.name}</a> at{" "}
          <a href="mailto:arman@orchestrat.dev">arman@orchestrat.dev</a>.
        </p>
      </section>
    </>
  );
}
