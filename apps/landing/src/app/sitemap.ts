import type { MetadataRoute } from "next";
import { contentPages } from "@/lib/content";
import { siteUrl } from "@/lib/seo";
import { docsPages } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl },
    ...contentPages.map((page) => ({
      url: `${siteUrl}/${page.slug}`,
      ...(page.published ? { lastModified: page.published } : {})
    })),
    ...docsPages().map((page) => ({ url: `${siteUrl}${page.url}` })),
    { url: `${siteUrl}/terms`, lastModified: "2026-10-14" },
    { url: `${siteUrl}/privacy`, lastModified: "2026-10-14" }
  ];
}
