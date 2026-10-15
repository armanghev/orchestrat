import type { ReactNode } from "react";
import Link from "next/link";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider";
import { DocsNavbar } from "@/components/layout/docs-navbar";
import { githubUrl } from "@/lib/links";
import { source } from "@/lib/source";

const mobileLinks = [
  { label: "Home", href: "/" },
  { label: "Guides", href: "/guides" },
  { label: "FAQ", href: "/faq" },
  { label: "GitHub", href: githubUrl }
];

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ enabled: false }}>
      <DocsLayout
        tree={source.pageTree}
        nav={{
          component: <DocsNavbar />,
          title: "Documentation",
          url: "/docs"
        }}
        themeSwitch={{ enabled: false }}
        sidebar={{ collapsible: false }}
        links={[
          {
            type: "custom",
            children: (
              // The site links live in the navbar on larger screens.
              <ul className="flex flex-wrap gap-x-5 gap-y-2 border-b pb-4 text-sm md:hidden">
                {mobileLinks.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-fd-muted-foreground hover:text-fd-primary"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            )
          }
        ]}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
