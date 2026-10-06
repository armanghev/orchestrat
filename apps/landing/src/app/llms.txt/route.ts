import { contentPages } from "@/lib/content";
import { founder, siteDescription, siteUrl } from "@/lib/seo";

export const dynamic = "force-static";

export function GET() {
  const links = (pages: typeof contentPages) =>
    pages
      .map(
        (page) =>
          `- [${page.title}](${siteUrl}/${page.slug}): ${page.description}`
      )
      .join("\n")
      .replaceAll(founder.name, `[${founder.name}](${founder.url})`);
  return new Response(
    `# Orchestrat

> ${siteDescription}

Built and operated by [${founder.name}](${founder.url}). Contact: arman@orchestrat.dev.
Private early access; public pricing and a general release date have not been announced.
Orchestrat coordinates coding tools; it does not run their AI models. The workspace runs in the browser and as a macOS app. Local coding agents connect through the CLI, and a hosted service stores shared project data.

## Product and documentation

- [Full product documentation and guides](${siteUrl}/llms-full.txt): Plain-text content of the product pages, FAQ, documentation, and guides below.
${links(contentPages.filter((page) => !page.slug.startsWith("guides")))}

## Guides

${links(contentPages.filter((page) => page.published))}

## Optional

- [Terms of Service](${siteUrl}/terms): Authoritative terms for the website, waitlist, and service.
- [Privacy Policy](${siteUrl}/privacy): Authoritative information about data handling and privacy requests.
- [Sitemap](${siteUrl}/sitemap.xml): Index of public pages.
`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
}
