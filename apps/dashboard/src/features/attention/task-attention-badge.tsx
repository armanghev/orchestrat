import { cn } from "@/lib/cn";
import { unreadCommentsLabel } from "./query-options";

/** Unread-comment dot for tasks the human watches (spec §14). */
export function TaskAttentionBadge({
  unread,
  mentions,
  className
}: {
  unread: number;
  mentions: number;
  className?: string;
}) {
  if (unread < 1) return null;
  return (
    <span
      role="img"
      aria-label={unreadCommentsLabel(unread, mentions)}
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium tabular-nums",
        className
      )}
    >
      <span className="size-1.5 rounded-full bg-brand" />
      <span>{unread}</span>
      {mentions ? <span className="text-primary-text">@{mentions}</span> : null}
    </span>
  );
}
