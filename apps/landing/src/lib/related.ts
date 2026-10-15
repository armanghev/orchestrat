import { contentPages } from "@/lib/content";
import { source } from "@/lib/source";

export type RelatedEntry = { slug: string; title: string; description: string };

/** Resolves a related-reading slug to a content page or a docs page. */
export function relatedEntry(slug: string): RelatedEntry {
  const page = contentPages.find((entry) => entry.slug === slug);
  if (page) return { slug, title: page.title, description: page.description };
  const [root, ...rest] = slug.split("/");
  const doc = root === "docs" ? source.getPage(rest) : undefined;
  if (!doc) throw new Error(`Missing related page: ${slug}`);
  return {
    slug,
    title: rest.length ? doc.data.title : "Orchestrat documentation",
    description: doc.data.description ?? ""
  };
}
