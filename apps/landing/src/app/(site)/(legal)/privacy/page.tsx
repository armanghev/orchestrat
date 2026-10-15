import Link from "next/link";
import { founder, pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata(
  "Privacy Policy",
  "How the orchestrat.dev website handles analytics, server logs, and correspondence. Self-hosted Orchestrat instances send nothing to us.",
  "/privacy"
);

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="text-xs">
        Last updated <time dateTime="2026-10-14">October 14, 2026</time>
      </p>
      <p>
        <a href={founder.url}>{founder.name}</a> operates orchestrat.dev (“we,”
        “us”) and is responsible for the personal information described here.
        This policy covers the orchestrat.dev website only: the landing page,
        guides, and documentation. It explains what the website collects, why,
        and the choices available to you.
      </p>

      <section>
        <h2>1. Self-hosted Orchestrat</h2>
        <p>
          Orchestrat is software you run yourself. A self-hosted instance, its
          dashboard, and the CLI send nothing to us. Accounts, project content,
          and agent activity stay on the servers you or your organization
          operate, and whoever runs an instance is responsible for the data it
          holds. This policy does not cover self-hosted instances.
        </p>
        <p>
          Other services you use with Orchestrat have their own policies. For
          example, installing the CLI downloads it from the npm registry, the
          source is hosted on GitHub, and the coding tools you connect may send
          project context to their own model providers.
        </p>
      </section>

      <section>
        <h2>2. Information the website collects</h2>
        <ul>
          <li>
            <strong>Analytics, only if you accept.</strong> Page views,
            referrers, approximate location, and device and browser information,
            processed as aggregate usage statistics. See section 4.
          </li>
          <li>
            <strong>Server logs.</strong> Our hosting provider processes request
            information such as IP addresses, browser details, requested pages,
            and timestamps to deliver the website and protect it from abuse.
          </li>
          <li>
            <strong>Correspondence.</strong> Your email address and anything you
            choose to send when you contact us.
          </li>
        </ul>
        <p>
          The website has no accounts, sign-up forms, or payment features, and
          does not ask for your name or company.
        </p>
      </section>

      <section>
        <h2>3. How we use information</h2>
        <p>
          We use this information to operate and secure the website, understand
          which pages are useful, respond to your messages, and meet legal
          obligations.
        </p>
        <p>
          Where a legal basis is required, we rely on our legitimate interests
          in operating and securing the website, your consent for optional
          analytics, or compliance with legal obligations. Where we rely on
          consent, you may withdraw it without affecting earlier lawful
          processing.
        </p>
      </section>

      <section id="cookies">
        <h2>4. Cookies, analytics, and local storage</h2>
        <p>
          If you accept optional analytics, the website uses Vercel Web
          Analytics to understand visits and improve the site. Analytics stays
          off until you accept. Vercel describes this analytics service as not
          using third-party cookies and using a temporary visitor hash rather
          than a persistent cross-site identifier. See{" "}
          <a href="https://vercel.com/docs/analytics/privacy-policy">
            Vercel’s analytics privacy documentation
          </a>{" "}
          for details.
        </p>
        <p>
          We store your analytics preference in your browser’s local storage
          under the key <code>orchestrat:analytics-consent:v1</code>. This
          stores only your choice, not an advertising identifier. Use “Cookie
          settings” in the footer to accept or reject optional analytics at any
          time. Rejecting stops future analytics events; it does not remove
          statistics already received. Your choice stays on this browser until
          you change it or clear site data. If browser storage is unavailable,
          the choice applies only to the current visit. The website works
          whether you accept or reject analytics.
        </p>
        <p>
          The website does not use advertising cookies, and we do not sell
          personal information or share it for targeted advertising.
        </p>
      </section>

      <section>
        <h2>5. When information is shared</h2>
        <p>
          Vercel hosts the website and provides its optional analytics, and
          processes the information described above to perform those services.
          We do not otherwise share website data, except when reasonably
          necessary to comply with law, respond to a valid legal request,
          prevent fraud or harm, or protect rights and security.
        </p>
      </section>

      <section>
        <h2>6. Retention</h2>
        <p>
          Analytics are kept as aggregate statistics. Server logs are kept by
          our hosting provider for a limited period under its own retention
          settings. We keep correspondence for as long as needed to respond and
          for reasonable record-keeping, and you can ask us to delete it.
        </p>
      </section>

      <section>
        <h2>7. Security and international processing</h2>
        <p>
          We use access controls designed to protect the information described
          here. No online service can guarantee complete security. Please do not
          send passwords, access tokens, or other secrets by email.
        </p>
        <p>
          We and our hosting provider may process information in countries other
          than where you live, which may have different privacy laws. Where
          applicable law requires protections for an international transfer,
          those requirements apply to our handling of the transfer.
        </p>
      </section>

      <section>
        <h2>8. Your choices and rights</h2>
        <p>
          Depending on your location and applicable law, you may have rights to
          access, correct, delete, or receive a copy of your personal
          information, or to object to or restrict certain processing. You may
          also have the right to complain to your local data protection
          authority. Contact us using the address below to make a request. We
          may need to verify your identity before responding.
        </p>
        <p>
          You can reject analytics, clear local browser data, or stop using the
          website at any time. The website does not currently change its
          behavior in response to a browser’s “Do Not Track” signal.
        </p>
      </section>

      <section>
        <h2>9. Children and policy updates</h2>
        <p>
          The website is intended for people using developer tools, not children
          under 13. We do not knowingly collect personal information from
          children under 13. If you believe a child has provided information,
          contact us so we can address it.
        </p>
        <p>
          We may update this policy as the website changes. We will update the
          date on this page and note material changes on the website. Use of the
          website is also subject to our{" "}
          <Link href="/terms">Terms of Service</Link>.
        </p>
      </section>

      <section>
        <h2>10. Contact</h2>
        <p>
          For privacy questions or requests, contact{" "}
          <a href={founder.url}>{founder.name}</a> at{" "}
          <a href="mailto:arman@orchestrat.dev">arman@orchestrat.dev</a>. Please
          do not include passwords, access tokens, or other secrets in your
          message.
        </p>
      </section>
    </>
  );
}
