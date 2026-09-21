import Link from "next/link";
import { founder, pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata(
  "Privacy Policy",
  "How Orchestrat handles waitlist, account, project, and analytics data, and how to contact us about your privacy.",
  "/privacy"
);

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="text-xs">
        Last updated <time dateTime="2026-09-20">September 20, 2026</time>
      </p>
      <p>
        <a href={founder.url}>{founder.name}</a> operates Orchestrat (“we,”
        “us”) and is responsible for the personal information described here.
        This policy covers orchestrat.dev, our waitlist, and the Orchestrat
        applications, CLI, and hosted services. It explains what we collect, why
        we use it, and the choices available to you.
      </p>

      <section>
        <h2>1. Information we collect</h2>
        <ul>
          <li>
            <strong>Waitlist and correspondence.</strong> Your email address
            when you join the waitlist, and any information you choose to send
            when you contact us. The waitlist stores your email address; the
            feature-interest buttons on the landing page are not submitted.
          </li>
          <li>
            <strong>Account information.</strong> When you use the app, your
            authentication identifier, email address, name, avatar, and any
            profile details you provide. Signing in with GitHub supplies
            information from that provider to create or maintain your account.
          </li>
          <li>
            <strong>Project content.</strong> Organization and project details,
            memberships, tasks, comments, documents, revision history, and
            attachments that you or your connected agents submit.
          </li>
          <li>
            <strong>Coordination and technical data.</strong> Agent and session
            identifiers, runtime information, task claims, lifecycle events,
            timestamps, and reported errors. Our hosting services may process
            request information such as IP addresses, browser details, and
            diagnostic logs to deliver and protect the Service.
          </li>
        </ul>
      </section>

      <section>
        <h2>2. How we use information</h2>
        <p>
          We use this information to manage early-access invitations, create and
          authenticate accounts, provide shared project state, synchronize agent
          activity, respond to support requests, maintain reliability, prevent
          abuse, and meet legal obligations. Waitlist emails are used for
          Orchestrat early-access communications; you can ask us to remove your
          address at any time.
        </p>
        <p>
          Where a legal basis is required, we rely on providing the service you
          request, our legitimate interests in operating and securing it, your
          consent where required, or compliance with legal obligations. Where we
          rely on consent, you may withdraw it without affecting earlier lawful
          processing.
        </p>
      </section>

      <section>
        <h2>3. Analytics and local storage</h2>
        <p>
          The website uses Vercel Web Analytics to understand visits and improve
          the site. It processes page views, referrers, approximate location,
          and device and browser information as aggregate usage statistics.
          Vercel describes this analytics service as not using third-party
          cookies and using a temporary visitor hash rather than a persistent
          cross-site identifier. See{" "}
          <a href="https://vercel.com/docs/analytics/privacy-policy">
            Vercel’s analytics privacy documentation
          </a>{" "}
          for details.
        </p>
        <p>
          The web dashboard stores authentication session information locally in
          your browser so you can stay signed in. The macOS app and CLI use
          macOS Keychain for supported credentials. Authentication providers may
          use their own cookies during sign-in. You can clear browser storage or
          disconnect integrations, though doing so may sign you out or stop a
          connection. Orchestrat does not use advertising cookies or sell
          personal information for targeted advertising.
        </p>
      </section>

      <section>
        <h2>4. When information is shared</h2>
        <p>
          We use service providers for hosting, authentication, databases,
          storage, and analytics. These include Vercel for the website and
          analytics, Supabase for authentication and database services, and
          Cloudflare R2 for document and attachment storage where configured.
          These providers process information needed to perform their services.
        </p>
        <p>
          Project content and activity are available to authorized project users
          and connected agents. Profile avatars may be accessible to anyone with
          their public image URL. When you connect a coding tool, it may
          retrieve project content and pass that context to its own provider.
          That provider’s terms and privacy policy govern its processing.
          Orchestrat does not run those models; review each tool’s permissions
          and data practices before connecting it.
        </p>
        <p>
          We may also disclose information when reasonably necessary to comply
          with law, respond to a valid legal request, prevent fraud or harm, or
          protect rights and security. If the Service is transferred to a new
          operator, information may transfer with it, subject to applicable law
          and notice of any material change in how it is handled.
        </p>
      </section>

      <section>
        <h2>5. Retention and deletion</h2>
        <p>
          We retain information for as long as needed to provide the Service and
          for legitimate operational, security, and legal purposes. The
          appropriate period depends on the information, your use of the
          Service, and any obligations to retain it.
        </p>
        <p>
          Archiving a project or document preserves its history; it does not
          erase it. Disconnecting an agent does not delete its past activity.
          Contact us to request removal from the waitlist, account closure, or
          deletion of personal information. Some records may need to be retained
          for legal or security reasons, and backups or storage cleanup may take
          additional time. We will explain any relevant limits when responding
          to your request.
        </p>
      </section>

      <section>
        <h2>6. Security and international processing</h2>
        <p>
          We use access controls and credential protections designed to
          safeguard information. No online service can guarantee complete
          security. Avoid submitting passwords, private keys, or unnecessary
          sensitive personal information in tasks, documents, or attachments.
        </p>
        <p>
          We and our service providers may process information in countries
          other than where you live, which may have different privacy laws.
          Where applicable law requires protections for an international
          transfer, those requirements apply to our handling of the transfer.
        </p>
      </section>

      <section>
        <h2>7. Your choices and rights</h2>
        <p>
          Depending on your location and applicable law, you may have rights to
          access, correct, delete, or receive a copy of your personal
          information, or to object to or restrict certain processing. You may
          also have the right to complain to your local data protection
          authority. Contact us using the address below to make a request. We
          may need to verify your identity and authority before responding.
        </p>
        <p>
          You can edit available profile settings, revoke connected agents,
          clear local browser data, or stop using the Service. The website does
          not currently change its behavior in response to a browser’s “Do Not
          Track” signal.
        </p>
      </section>

      <section>
        <h2>8. Children and policy updates</h2>
        <p>
          Orchestrat is intended for people using developer tools, not children
          under 13. We do not knowingly collect personal information from
          children under 13. If you believe a child has provided information,
          contact us so we can investigate and address it.
        </p>
        <p>
          We may update this policy as the Service changes. We will update the
          date on this page and give notice of material changes through the
          website, the app, or email as appropriate. Use of the Service is also
          subject to our <Link href="/terms">Terms of Service</Link>.
        </p>
      </section>

      <section>
        <h2>9. Contact</h2>
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
