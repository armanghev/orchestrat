import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function PageHeader({
  title,
  description,
  actions
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 tabIndex={-1} className="text-2xl font-semibold tracking-tight">
          {title}
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

export function PageState({
  title,
  message,
  error = false,
  onRetry
}: {
  title: string;
  message: string;
  error?: boolean;
  onRetry?: () => unknown;
}) {
  return (
    <section className="dashboard-page">
      <PageHeader title={title} description={message} />
      {error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : (
        <div
          role="status"
          aria-label={message}
          className="grid gap-4 sm:grid-cols-2"
        >
          <Skeleton className="h-36 rounded-xl" />
          <Skeleton className="h-36 rounded-xl" />
          <Skeleton className="h-64 rounded-xl sm:col-span-2" />
        </div>
      )}
      {onRetry ? (
        <Button
          variant="outline"
          className="self-start"
          onClick={() => void onRetry()}
        >
          Try again
        </Button>
      ) : null}
    </section>
  );
}

export function StatusBadge({ status }: { status: string }) {
  // Archived projects and branches use the neutral tone plus their label.
  const variant =
    status === "archived"
      ? "secondary"
      : status === "blocked" || status === "cancelled" || status === "error"
        ? "destructive"
        : status === "online" || status === "active" || status === "done"
          ? "success"
          : status === "review" ||
              status === "stale" ||
              status === "needs_reauthorization" ||
              status === "suspended"
            ? "warning"
            : status === "in_progress" || status === "claimed"
              ? "info"
              : "secondary";
  return (
    <Badge variant={variant}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {status.charAt(0).toLocaleUpperCase() +
        status.slice(1).replaceAll("_", " ")}
    </Badge>
  );
}
