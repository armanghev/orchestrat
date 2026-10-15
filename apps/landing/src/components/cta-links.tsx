import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { GitHubMark } from "@/components/graphics/github-mark";
import { githubUrl, quickstartHref } from "@/lib/links";

export function CtaLinks({
  className = "",
  secondary = "button-ghost"
}: {
  className?: string;
  secondary?: "button-ghost" | "button-outline";
}) {
  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      <Link href={quickstartHref} className="button button-primary">
        Self-host it
        <ArrowRight size={16} aria-hidden="true" />
      </Link>
      <a href={githubUrl} className={`button ${secondary}`}>
        <GitHubMark />
        GitHub
      </a>
    </div>
  );
}
