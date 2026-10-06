import type { CSSProperties, ReactNode } from "react";
import { clsx } from "clsx";
import { Pause, Play, User } from "lucide-react";

// Harness logos: @lobehub/icons-static-svg 1.95.1 (MIT), in public/logos.
export const agents = {
  claude: { name: "Claude Code", logo: "/logos/claudecode-color.svg" },
  codex: { name: "Codex", logo: "/logos/codex-color.svg" },
  cursor: { name: "Cursor", logo: "/logos/cursor.svg" },
  antigravity: { name: "Antigravity", logo: "/logos/antigravity-color.svg" },
  you: { name: "You", logo: null }
} as const;

export type AgentId = keyof typeof agents;

export function AgentMark({
  agent,
  className = "size-6"
}: {
  agent: AgentId;
  className?: string;
}) {
  const { logo } = agents[agent];
  if (!logo)
    return (
      <span
        aria-hidden="true"
        className={clsx("agent-mark bg-foreground text-background", className)}
      >
        <User className="size-[62%]" strokeWidth={2.4} />
      </span>
    );
  return (
    <span aria-hidden="true" className={clsx("agent-logo", className)}>
      <img src={logo} alt="" width={24} height={24} draggable={false} />
    </span>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

export function WindowBar({
  title,
  right
}: {
  title: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="window-bar">
      <span aria-hidden="true" className="window-dots">
        <span />
        <span />
        <span />
      </span>
      <span className="min-w-0 truncate">{title}</span>
      {right && <span className="ml-auto shrink-0">{right}</span>}
    </div>
  );
}

export function delay(index: number, step = 90): CSSProperties {
  return { transitionDelay: `${index * step}ms` };
}

/** Pause/play control for an auto-playing demo (WCAG 2.2.2). */
export function PauseButton({
  paused,
  onToggle,
  label,
  className = ""
}: {
  paused: boolean;
  onToggle: () => void;
  label: string;
  className?: string;
}) {
  const Icon = paused ? Play : Pause;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`${paused ? "Play" : "Pause"} ${label}`}
      className={clsx(
        "flex size-8 items-center justify-center rounded-full border bg-card/90 text-muted-foreground backdrop-blur transition-colors hover:text-foreground",
        className
      )}
    >
      <Icon size={13} aria-hidden="true" fill="currentColor" />
    </button>
  );
}
