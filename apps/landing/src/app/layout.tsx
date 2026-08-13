import type { Metadata } from "next";
import "./globals.css";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Outfit, Space_Grotesk } from "next/font/google";

const outfit = Outfit({ subsets: ["latin"], variable: "--font-sans" });
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-heading"
});

export const metadata: Metadata = {
  title: "orchestrat | Coordinate agents. Keep control.",
  description:
    "A shared coordination plane where humans and autonomous agents manage tasks, messages, documents, and project activity."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${outfit.variable} ${spaceGrotesk.variable}`}>
      <body className="min-h-full bg-zinc-950 font-sans text-zinc-100 selection:bg-zinc-800 selection:text-zinc-200">
        <Navbar />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
