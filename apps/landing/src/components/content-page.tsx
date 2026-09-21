import Link from "next/link";
import { Fragment } from "react";
import { StructuredData } from "@/components/structured-data";
import { contentPages } from "@/lib/content";
import { founder, organization, pageMetadata, siteUrl } from "@/lib/seo";

function linkedProfile(text: string) {
  return text.split(founder.name).map((part, index) => (
    <Fragment key={index}>
      {index > 0 && (
        <a
          href={founder.url}
          className="underline underline-offset-4 hover:text-primary-text"
        >
          {founder.name}
        </a>
      )}
      {part}
    </Fragment>
  ));
}

function getPage(slug: string) {
  const page = contentPages.find((entry) => entry.slug === slug);
  if (!page) throw new Error(`Missing page content: ${slug}`);
  return page;
}

export function contentMetadata(slug: string) {
  const page = getPage(slug);
  return pageMetadata(
    page.title,
    page.description,
    `/${page.slug}`,
    page.published
  );
}

export function ContentPage({ slug }: { slug: string }) {
  const page = getPage(slug);
  const url = `${siteUrl}/${page.slug}`;
  const breadcrumbs = [
    { name: "Home", item: siteUrl },
    ...(page.published ? [{ name: "Guides", item: `${siteUrl}/guides` }] : []),
    { name: page.title, item: url }
  ];
  const related = page.related.map((slug) =>
    contentPages.find((entry) => entry.slug === slug)!
  );

  return (
    <div className="site-container py-12 md:py-20">
      <StructuredData
        data={{
          "@context": "https://schema.org",
          "@graph": [
            organization,
            {
              "@type": page.published
                ? "Article"
                : page.slug === "faq"
                  ? "FAQPage"
                  : page.slug === "about"
                    ? "AboutPage"
                    : "WebPage",
              "@id": `${url}#page`,
              url,
              name: page.title,
              description: page.description,
              inLanguage: "en",
              publisher: { "@id": organization["@id"] },
              ...(page.published
                ? {
                    headline: page.title,
                    datePublished: page.published,
                    dateModified: page.published,
                    author: {
                      "@type": "Organization",
                      name: "Orchestrat",
                      url: `${siteUrl}/about`
                    },
                    mainEntityOfPage: url,
                    image: `${siteUrl}/opengraph-image`
                  }
                : {}),
              ...(page.slug === "faq"
                ? {
                    mainEntity: page.sections.map((section) => ({
                      "@type": "Question",
                      name: section.heading,
                      acceptedAnswer: {
                        "@type": "Answer",
                        text: section.paragraphs.join("\n\n")
                      }
                    }))
                  }
                : {})
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
      <nav
        aria-label="Breadcrumb"
        className="mx-auto mb-12 max-w-3xl text-sm text-muted-foreground"
      >
        <ol className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {breadcrumbs.map((crumb, index) => (
            <li key={crumb.item} className="flex items-center gap-3">
              {index > 0 && <span aria-hidden="true">/</span>}
              {index === breadcrumbs.length - 1 ? (
                <span aria-current="page">
                  {page.published ? "Article" : page.title}
                </span>
              ) : (
                <Link
                  href={index === 0 ? "/" : "/guides"}
                  className="hover:text-primary-text"
                >
                  {crumb.name}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <article className="mx-auto max-w-3xl">
        <header className="border-b pb-10">
          <p className="mb-5 text-sm text-primary-text">
            {page.published
              ? "The Orchestrat guides"
              : "Orchestrat / Resources"}
          </p>
          <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-balance md:text-5xl">
            {page.title}
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
            {linkedProfile(page.intro)}
          </p>
          {page.published && (
            <p className="mt-7 text-sm text-muted-foreground">
              By{" "}
              <Link
                href="/about"
                className="text-foreground hover:text-primary-text"
              >
                Orchestrat
              </Link>{" "}
              ·{" "}
              <time dateTime={page.published}>
                {new Date(`${page.published}T00:00:00Z`).toLocaleDateString(
                  "en-US",
                  {
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                    timeZone: "UTC"
                  }
                )}
              </time>
            </p>
          )}
        </header>
        {page.sections.length > 3 && (
          <nav aria-label="On this page" className="border-b py-7">
            <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              On this page
            </p>
            <ol className="space-y-2 text-sm leading-relaxed">
              {page.sections.map((section, index) => (
                <li key={section.heading}>
                  <a
                    className="text-muted-foreground hover:text-primary-text"
                    href={`#section-${index + 1}`}
                  >
                    {section.heading}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        )}
        <div className="content-prose">
          {page.sections.map((section, index) => (
            <section
              key={section.heading}
              id={`section-${index + 1}`}
              className="mt-12"
            >
              <h2>{linkedProfile(section.heading)}</h2>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph}>{linkedProfile(paragraph)}</p>
              ))}
              {section.bullets && (
                <ul>
                  {section.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              )}
              {section.code && (
                <pre>
                  <code>{section.code}</code>
                </pre>
              )}
              {section.links && (
                <ul className="content-links">
                  {section.links.map((link) => (
                    <li key={link.href}>
                      <Link href={link.href}>
                        {link.label} <span aria-hidden="true">↗</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
        <aside
          aria-label={page.slug === "guides" ? "All guides" : "Related reading"}
          className="mt-14 border-t pt-8"
        >
          <h2 className="mb-2 text-sm text-primary-text">
            {page.slug === "guides" ? "Start reading" : "Keep reading"}
          </h2>
          <ul className="divide-y">
            {related.map((entry) => (
              <li key={entry.slug} className="py-6">
                <Link
                  href={`/${entry.slug}`}
                  className="text-lg font-medium tracking-tight hover:text-primary-text"
                >
                  {entry.title} <span aria-hidden="true">↗</span>
                </Link>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {linkedProfile(entry.description)}
                </p>
              </li>
            ))}
          </ul>
        </aside>
        <div className="mt-10 flex flex-wrap items-center justify-between gap-6 border-t pt-8">
          <p className="text-sm text-muted-foreground">
            Bring your agents onto the same page.
          </p>
          <Link className="button button-primary" href="/#waitlist">
            Join the waitlist
          </Link>
        </div>
      </article>
    </div>
  );
}
