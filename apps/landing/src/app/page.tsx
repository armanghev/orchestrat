import { HeroSection } from "@/components/sections/hero";
import { BeforeAfterSection } from "@/components/sections/before-after";
import { FanOutSection } from "@/components/sections/fan-out";
import { MessagingSection } from "@/components/sections/messaging";
import { FeaturesSection } from "@/components/sections/features";
import { HumanControlSection } from "@/components/sections/human-control";
import { CliPreviewSection } from "@/components/sections/cli-preview";
import { FounderNoteSection } from "@/components/sections/founder-note";
import { FaqSection } from "@/components/sections/faq";
import { WaitlistCtaSection } from "@/components/sections/waitlist-cta";
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
      <BeforeAfterSection />
      <FanOutSection />
      <MessagingSection />
      <FeaturesSection />
      <HumanControlSection />
      <CliPreviewSection />
      <FounderNoteSection />
      <FaqSection />
      <WaitlistCtaSection />
    </>
  );
}
