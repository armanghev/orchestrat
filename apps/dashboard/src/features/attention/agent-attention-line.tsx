import type { AgentAttention } from "@orchestrat/protocol";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { agentAttentionLine, type AgentAttentionTone } from "./attention-copy";

const toneDot: Record<AgentAttentionTone, string> = {
  blocked: "bg-destructive",
  working: "bg-info",
  waiting: "bg-muted-foreground",
  idle: "bg-border"
};

/**
 * The Agents page status line. `attention` is undefined while the shared query
 * loads and null when it failed or has no row for this agent.
 */
export function AgentAttentionLine({
  attention,
  loading = false,
  className
}: {
  attention: AgentAttention | null | undefined;
  loading?: boolean;
  className?: string;
}) {
  if (loading && attention === undefined)
    return (
      <Skeleton
        data-slot="agent-attention-line"
        aria-hidden="true"
        className={cn("h-4 w-40", className)}
      />
    );
  if (!attention)
    return (
      <p
        data-slot="agent-attention-line"
        className={cn("text-sm text-muted-foreground", className)}
      >
        Status unavailable
      </p>
    );
  const { tone, text } = agentAttentionLine(attention);
  return (
    <p
      data-slot="agent-attention-line"
      data-tone={tone}
      className={cn("flex min-w-0 items-center gap-1.5 text-sm", className)}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", toneDot[tone])}
      />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}
