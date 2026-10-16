import type { Metadata } from "next";
import { licenseUrl } from "@/lib/links";

export const siteUrl = "https://orchestrat.dev";
export const siteDescription =
  "Orchestrat is a self-hosted coordination plane for AI coding agents: claimed tasks, versioned plans, project chats, and live activity. Source-available and free to self-host.";

export function pageMetadata(
  title: string,
  description: string,
  path: string,
  articleDate?: string,
  section = "Orchestrat"
): Metadata {
  const url = `${siteUrl}${path}`;
  const fullTitle = `${title} | ${section}`;
  const images = [
    {
      url: `${siteUrl}/opengraph-image`,
      width: 1200,
      height: 630,
      alt: "Orchestrat workspace for AI coding agents"
    }
  ];
  return {
    title: fullTitle,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: fullTitle,
      description,
      url,
      siteName: "Orchestrat",
      locale: "en_US",
      images,
      ...(articleDate
        ? {
            type: "article",
            publishedTime: articleDate,
            modifiedTime: articleDate,
            authors: [`${siteUrl}/about`]
          }
        : { type: "website" })
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images
    }
  };
}

export const founder = {
  "@type": "Person",
  name: "@armanghev",
  url: "https://x.com/armanghev"
};

export const organization = {
  "@type": "Organization",
  "@id": `${siteUrl}/#organization`,
  name: "Orchestrat",
  url: siteUrl,
  logo: `${siteUrl}/icon.png`,
  email: "arman@orchestrat.dev",
  founder
};

export const homeStructuredData = {
  "@context": "https://schema.org",
  "@graph": [
    organization,
    {
      "@type": "WebSite",
      "@id": `${siteUrl}/#website`,
      name: "Orchestrat",
      url: siteUrl,
      description: siteDescription,
      inLanguage: "en",
      publisher: { "@id": organization["@id"] }
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${siteUrl}/#software`,
      name: "Orchestrat",
      url: siteUrl,
      description: siteDescription,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux",
      isAccessibleForFree: true,
      license: licenseUrl,
      publisher: { "@id": organization["@id"] },
      image: `${siteUrl}/icon.png`,
      screenshot: `${siteUrl}/images/orchestrat-macos-overview.png`,
      featureList: [
        "Shared tasks and exclusive ownership",
        "Versioned Markdown documents",
        "Project chats",
        "Agent activity",
        "Project branches synced with Git",
        "Local MCP bridge",
        "Lifecycle hooks",
        "Project API",
        "Self-hosted with Docker Compose"
      ]
    }
  ]
};
