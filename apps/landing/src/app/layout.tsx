import type { Metadata } from "next";
import "./globals.css";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Outfit, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";

const outfit = Outfit({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono"
});

export const metadata: Metadata = {
  title: "orchestrat | Coordinate agents. Keep control.",
  description:
    "A shared coordination plane where humans and autonomous agents manage tasks, claims, documents, and project activity."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`dark ${outfit.variable} ${geistMono.variable}`}
    >
      <body className="noise min-h-full bg-background font-sans text-foreground selection:bg-accent selection:text-accent-foreground">
        <Navbar />
        <main>{children}</main>
        <Footer />
        <Analytics />
      </body>
    </html>
  );
}
