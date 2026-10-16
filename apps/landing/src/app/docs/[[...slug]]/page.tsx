import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageFooter } from "fumadocs-ui/layouts/docs/page";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle
} from "fumadocs-ui/page";
import { DocsFooter } from "@/components/docs/docs-footer";
import { getMDXComponents } from "@/components/docs/mdx";
import { StructuredData } from "@/components/structured-data";
import { organization, pageMetadata, siteUrl } from "@/lib/seo";
import { source } from "@/lib/source";

type Props = { params: Promise<{ slug?: string[] }> };

export default async function Page({ params }: Props) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const MDX = page.data.body;
  const url = `${siteUrl}${page.url}`;
  const breadcrumbs = [
    { name: "Home", item: siteUrl },
    { name: "Docs", item: `${siteUrl}/docs` },
    ...(page.url === "/docs" ? [] : [{ name: page.data.title, item: url }])
  ];

  return (
    <DocsPage
      toc={page.data.toc}
      full={page.data.full}
      article={{ id: "main-content" }}
      footer={{
        component: (
          <>
            <PageFooter />
            <DocsFooter />
          </>
        )
      }}
    >
      <StructuredData
        data={{
          "@context": "https://schema.org",
          "@graph": [
            organization,
            {
              "@type": "TechArticle",
              "@id": `${url}#page`,
              url,
              headline: page.data.title,
              name: page.data.title,
              description: page.data.description,
              inLanguage: "en",
              publisher: { "@id": organization["@id"] },
              mainEntityOfPage: url
            },
            {
              "@type": "BreadcrumbList",
              itemListElement: breadcrumbs.map((crumb, index) => ({
                "@type": "ListItem",
                position: index + 1,
                ...crumb
              }))
            }
          ]
        }}
      />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

// Unknown docs paths get the site's 404 page instead of rendering on demand.
export const dynamicParams = false;

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();
  return pageMetadata(
    page.data.title,
    page.data.description ?? "",
    page.url,
    undefined,
    "Orchestrat docs"
  );
}
