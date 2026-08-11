import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "orchestrat.dev",
  description: "A coordination plane for humans and autonomous agents."
};
export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
