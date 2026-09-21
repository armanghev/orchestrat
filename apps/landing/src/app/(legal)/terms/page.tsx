import Link from "next/link";
import { founder, pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata(
  "Terms of Service",
  "Terms for using the Orchestrat website, waitlist, and agent coordination service.",
  "/terms"
);

export default function TermsPage() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p className="text-xs">
        Last updated <time dateTime="2026-09-20">September 20, 2026</time>
      </p>
      <p>
        These terms govern your use of orchestrat.dev, its waitlist, and the
        Orchestrat applications, CLI, and hosted services (the “Service”). The
        Service is operated by <a href={founder.url}>{founder.name}</a>{" "}
        (“Orchestrat,” “we,” “us”). By using the Service, you agree to these
        terms. If you do not agree, do not use the Service.
      </p>

      <section>
        <h2>1. Eligibility and your account</h2>
        <p>
          You must be legally able to enter into these terms. If you use
          Orchestrat for an organization, you must have authority to act for it.
          Provide accurate account information, protect your credentials, and
          only connect accounts and projects you are authorized to access. Tell
          us promptly if you suspect unauthorized access.
        </p>
      </section>

      <section>
        <h2>2. Early access and availability</h2>
        <p>
          Orchestrat is in private early access. Features may change, be
          interrupted, or be discontinued, and the Service may contain bugs or
          lose data. Keep independent copies of important work. Joining the
          waitlist does not guarantee access, a release date, or any particular
          feature, and does not create a paid subscription. Any future paid
          offering will disclose its pricing and payment terms before you agree
          to pay.
        </p>
      </section>

      <section>
        <h2>3. Agents and third-party services</h2>
        <p>
          Orchestrat coordinates tasks, claims, documents, and activity. It does
          not run the AI models in the coding tools you connect. You choose
          which agents and integrations to authorize and are responsible for
          reviewing their work, controlling their access, and approving actions
          that affect your systems or data.
        </p>
        <p>
          Connected tools, authentication providers, and other third-party
          services have their own terms and privacy practices. We do not
          guarantee their availability or the accuracy, safety, or suitability
          of agent output. A task status or claim is not a guarantee that the
          underlying work is correct or complete.
        </p>
      </section>

      <section>
        <h2>4. Your content</h2>
        <p>
          You retain ownership of the content you submit, including tasks,
          comments, documents, and attachments. You give us permission to host,
          store, process, and display that content only as needed to provide,
          maintain, and secure the Service and carry out your instructions. You
          are responsible for having the rights and permissions needed to submit
          it and make it available to the people and agents you authorize.
        </p>
        <p>
          Do not put passwords, private keys, or other secrets in project
          content. Our <Link href="/privacy">Privacy Policy</Link> describes how
          we handle personal information. Our software, branding, and other
          materials remain the property of their respective owners; any
          separately supplied open-source license governs the software it
          covers.
        </p>
      </section>

      <section>
        <h2>5. Acceptable use</h2>
        <p>You must not use the Service to:</p>
        <ul>
          <li>Break the law or infringe another person’s rights.</li>
          <li>
            Access projects or data without permission, bypass access controls,
            or misuse another person’s credentials.
          </li>
          <li>
            Distribute malware, send spam, or disrupt or overload the Service.
          </li>
          <li>
            Upload unlawful content or use connected agents for unauthorized or
            harmful activity.
          </li>
        </ul>
      </section>

      <section>
        <h2>6. Suspension and ending use</h2>
        <p>
          You may stop using the Service at any time, disconnect integrations,
          and contact us about account closure or deletion. We may restrict or
          suspend access to address a violation of these terms, a security
          threat, abuse, or a legal requirement. We may also end the
          early-access program. Where reasonably possible, we will give notice
          before ending access so you can save your work. Data retention is
          described in the Privacy Policy.
        </p>
      </section>

      <section>
        <h2>7. Disclaimers and liability</h2>
        <p>
          To the extent permitted by applicable law, the Service is provided “as
          is” and “as available,” without warranties of merchantability, fitness
          for a particular purpose, or non-infringement. We do not promise
          uninterrupted, error-free, or completely secure operation.
        </p>
        <p>
          To the extent permitted by applicable law, we are not liable for
          indirect or consequential losses, lost profits, or lost business
          opportunities arising from your use of the Service. Nothing in these
          terms excludes liability that cannot lawfully be excluded, including
          for fraud or willful misconduct, or limits your mandatory consumer
          rights.
        </p>
      </section>

      <section>
        <h2>8. Changes to these terms</h2>
        <p>
          We may update these terms as the Service evolves. We will post the
          updated version here with a new date and provide reasonable notice of
          material changes, such as through the Service or by email. Where the
          law requires your agreement, we will ask for it. Otherwise, your
          continued use after an update takes effect means you accept the
          updated terms.
        </p>
      </section>

      <section>
        <h2>9. Contact</h2>
        <p>
          Questions about these terms or the Service can be sent to{" "}
          <a href={founder.url}>{founder.name}</a> at{" "}
          <a href="mailto:arman@orchestrat.dev">arman@orchestrat.dev</a>.
        </p>
      </section>
    </>
  );
}
