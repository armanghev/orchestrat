import { contentPages } from "@/lib/content";
import { githubUrl, licenseUrl } from "@/lib/links";
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

Built and maintained by [${founder.name}](${founder.url}). Contact: arman@orchestrat.dev.
Source-available under the Elastic License 2.0 and free to self-host: ${githubUrl}. There is no hosted service; ${siteUrl} hosts only this site and the documentation.
Orchestrat coordinates coding tools; it does not run their AI models. You run the server with Docker Compose and Postgres, open the dashboard in a browser, and connect local coding agents through the CLI on macOS or Linux. Project data stays on your server.

## Product and documentation

- [Full product documentation and guides](${siteUrl}/llms-full.txt): Plain-text content of the product pages, FAQ, documentation, and guides below.
${links(contentPages.filter((page) => !page.slug.startsWith("guides")))}

## Guides

${links(contentPages.filter((page) => page.published))}

## Optional

- [Terms of Service](${siteUrl}/terms): Terms for using the website. The software is governed by its license.
- [License](${licenseUrl}): Elastic License 2.0.
- [Privacy Policy](${siteUrl}/privacy): How the website handles data, and how to make privacy requests.
- [Sitemap](${siteUrl}/sitemap.xml): Index of public pages.
`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
}
