import { HeroSection } from "@/components/sections/hero";
import { CliPreviewSection } from "@/components/sections/cli-preview";
import { WaitlistCtaSection } from "@/components/sections/waitlist-cta";
import { SharedStatePreviewSection } from "@/components/sections/shared-state-preview";

import { StructuredData } from "@/components/structured-data";
import { homeStructuredData, pageMetadata, siteDescription } from "@/lib/seo";

export const metadata = pageMetadata(
  "Coordinate your AI coding agents",
  siteDescription,
  ""
);

export default function Home() {
  return (
    <>
      <StructuredData data={homeStructuredData} />
      <HeroSection />
      <SharedStatePreviewSection />
      <CliPreviewSection />
      <WaitlistCtaSection />
    </>
  );
}
