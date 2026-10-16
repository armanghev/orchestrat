import { contentPages } from "@/lib/content";
import { githubUrl, licenseUrl } from "@/lib/links";
import { relatedEntry } from "@/lib/related";
import { docsPages, mdxToText } from "@/lib/source";
import { founder, siteDescription, siteUrl } from "@/lib/seo";

export const dynamic = "force-static";

export async function GET() {
  const docs = await Promise.all(
    docsPages().map(async (page) =>
      [
        `# ${page.data.title}`,
        `Source: ${siteUrl}${page.url}`,
        ...(page.data.description ? [page.data.description] : []),
        mdxToText(await page.data.getText("raw"))
      ].join("\n\n")
    )
  );
  const pages = contentPages
    .map((page) =>
      [
        `# ${page.title}`,
        `Source: ${siteUrl}/${page.slug}`,
        ...(page.published
          ? [
              `Published: ${page.published}\nAuthor: Orchestrat (${siteUrl}/about)`
            ]
          : []),
        page.intro,
        ...page.sections.map((section) =>
          [
            `## ${section.heading}`,
            ...section.paragraphs,
            ...(section.bullets
              ? [section.bullets.map((bullet) => `- ${bullet}`).join("\n")]
              : []),
            ...(section.code ? [`\`\`\`\n${section.code}\n\`\`\``] : []),
            ...(section.links
              ? [
                  section.links
                    .map(
                      (link) =>
                        `- [${link.label}](${link.href.startsWith("/") ? siteUrl + link.href : link.href})`
                    )
                    .join("\n")
                ]
              : [])
          ].join("\n\n")
        ),
        `## Related reading\n\n${page.related.map((slug) => `- [${relatedEntry(slug).title}](${siteUrl}/${slug})`).join("\n")}`
      ].join("\n\n")
    )
    .join("\n\n---\n\n")
    .replaceAll(founder.name, `[${founder.name}](${founder.url})`);

  return new Response(
    `# Orchestrat — full product documentation and guides

> ${siteDescription}

Website: ${siteUrl}
Built and maintained by [${founder.name}](${founder.url}). Contact: arman@orchestrat.dev.
Source: ${githubUrl} (Elastic License 2.0, source-available, free to self-host).
This file contains the public product, FAQ, guide, and documentation content. Legal policies are maintained separately at the authoritative links below.

${pages}

---

${docs.join("\n\n---\n\n")}

---

## Legal policies

- [Terms of Service](${siteUrl}/terms)
- [Privacy Policy](${siteUrl}/privacy)
- [License](${licenseUrl})
`,
    { headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
}
