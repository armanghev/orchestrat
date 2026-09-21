import type { MetadataRoute } from "next";
import { contentPages } from "@/lib/content";
import { siteUrl } from "@/lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl },
    ...contentPages.map((page) => ({
      url: `${siteUrl}/${page.slug}`,
      ...(page.published ? { lastModified: page.published } : {})
    })),
    { url: `${siteUrl}/terms`, lastModified: "2026-09-20" },
    { url: `${siteUrl}/privacy`, lastModified: "2026-09-20" }
  ];
}
