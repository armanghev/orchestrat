import type { Metadata } from "next";
import "./globals.css";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Analytics } from "@vercel/analytics/next";

export const metadata: Metadata = {
  title: "Orchestrat | Keep your agents on the same page.",
  description:
    "Coordinate tasks, shared documents, and live agent activity in one workspace. A clear view of the work, with you in control.",
  icons: {
    icon: "/favicon.ico"
  }
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body className="min-h-screen">
        <a
          href="#main-content"
          className="sr-only fixed top-4 left-4 z-[60] rounded-md bg-primary px-4 py-3 text-primary-foreground focus:not-sr-only"
        >
          Skip to content
        </a>
        <Navbar />
        <main id="main-content">{children}</main>
        <Footer />
        <Analytics />
      </body>
    </html>
  );
}
