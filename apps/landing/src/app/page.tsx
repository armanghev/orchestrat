import { HeroSection } from "@/components/sections/hero";
import { CliPreviewSection } from "@/components/sections/cli-preview";
import { WorkflowSection } from "@/components/sections/workflow";
import { WaitlistCtaSection } from "@/components/sections/waitlist-cta";
import { SharedStatePreviewSection } from "@/components/sections/shared-state-preview";
import { ProblemSection } from "@/components/sections/problem";
import { StatusRail } from "@/components/sections/status-rail";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100 selection:bg-zinc-800 selection:text-zinc-200">
      <HeroSection />
      <StatusRail />
      <ProblemSection />
      <SharedStatePreviewSection />
      <CliPreviewSection />
      <WorkflowSection />
      <WaitlistCtaSection />
    </div>
  );
}
