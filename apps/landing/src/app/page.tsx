import { HeroSection } from "@/components/sections/hero";
import { CliPreviewSection } from "@/components/sections/cli-preview";
import { WaitlistCtaSection } from "@/components/sections/waitlist-cta";
import { SharedStatePreviewSection } from "@/components/sections/shared-state-preview";

export default function Home() {
  return (
    <>
      <HeroSection />
      <SharedStatePreviewSection />
      <CliPreviewSection />
      <WaitlistCtaSection />
    </>
  );
}
