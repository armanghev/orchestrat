import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AttentionTaskRef, TaskBlock } from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { coordinationKeys } from "@/features/coordination/query-options";
import type { ApiClient } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import {
  blockIsGone,
  blockedTaskLine,
  relativeTime,
  resolveBlockErrorMessage
} from "./attention-copy";
import { invalidateAttentionQueries } from "./query-options";

/** "Blocked · waiting on codex" or "Blocked by ORC-4" on board and list rows. */
export function BlockedTaskLine({
  block,
  className
}: {
  block: TaskBlock;
  className?: string;
}) {
  return (
    <p
      data-slot="blocked-task-line"
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
        className
      )}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-destructive"
      />
      <span className="truncate">{blockedTaskLine(block)}</span>
    </p>
  );
}

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

type BlockedCalloutProps = {
  api: ApiClient;
  projectId: string;
  taskKey: string;
  block: TaskBlock;
  archived: boolean;
  /** Renders the blocking task as a link; plain text when omitted. */
  renderTaskLink?: (task: AttentionTaskRef) => ReactNode;
  /** Called after a resolve closes the dialog; the callout then unmounts. */
  onResolved?: () => void;
};

/**
 * The task sheet's blocked region (spec §14): reason, what it waits on, since
 * when, and Resolve blocker behind a confirmation.
 */
export function BlockedCallout({
  api,
  projectId,
  taskKey,
  block,
  archived,
  renderTaskLink,
  onResolved
}: BlockedCalloutProps) {
  const headingId = useId();
  const now = useNow();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // Set when the block is gone: resolved here, or already resolved elsewhere.
  const resolvedRef = useRef(false);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: coordinationKeys.tasks(projectId)
      }),
      queryClient.invalidateQueries({
        queryKey: coordinationKeys.task(block.task_id)
      }),
      invalidateAttentionQueries(queryClient, projectId)
    ]);
  const resolve = useMutation({
    mutationFn: () => api.resolveTaskBlock(block.task_id),
    onSuccess: () => {
      resolvedRef.current = true;
      setOpen(false);
      void refresh();
    },
    // A stale blocker refreshes only once the dialog closes, so the error
    // stays readable instead of vanishing with the callout.
    onError: (error) => {
      resolvedRef.current = blockIsGone(error);
    }
  });
  const changeOpen = (next: boolean) => {
    if (resolve.isPending) return;
    if (next) {
      resolve.reset();
      resolvedRef.current = false;
    } else if (resolvedRef.current) void refresh();
    setOpen(next);
  };
  const blockedOn = block.blocked_on;
  return (
    <section
      aria-labelledby={headingId}
      data-slot="blocked-callout"
      className="mt-5 rounded-md bg-muted p-3 text-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3
            id={headingId}
            className="flex items-center gap-1.5 text-sm font-medium"
          >
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full bg-destructive"
            />
            Blocked
          </h3>
          <p className="mt-1 whitespace-pre-wrap break-words">{block.reason}</p>
          <dl className="mt-2 grid gap-1 text-xs text-muted-foreground">
            {block.blocking_task ? (
              <div className="flex min-w-0 flex-wrap gap-1">
                <dt>Blocked by</dt>
                <dd className="min-w-0 text-foreground">
                  {renderTaskLink ? (
                    renderTaskLink(block.blocking_task)
                  ) : (
                    <span>
                      <span className="font-mono">
                        {block.blocking_task.key}
                      </span>{" "}
                      {block.blocking_task.title}
                    </span>
                  )}
                </dd>
              </div>
            ) : null}
            {blockedOn ? (
              <div className="flex flex-wrap gap-1">
                <dt>Waiting on</dt>
                <dd className="text-foreground">
                  {blockedOn.name}
                  {blockedOn.type === "agent" ? " (agent)" : ""}
                </dd>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-1">
              <dt>Since</dt>
              <dd>
                <time
                  dateTime={block.created_at}
                  title={new Date(block.created_at).toLocaleString()}
                >
                  {relativeTime(block.created_at, now)}
                </time>
                {" · reported by "}
                {block.created_by.name}
              </dd>
            </div>
          </dl>
        </div>
        <Dialog open={open} onOpenChange={changeOpen}>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={archived}
            >
              Resolve blocker
            </Button>
          </DialogTrigger>
          <DialogContent
            showCloseButton={!resolve.isPending}
            onEscapeKeyDown={(event) =>
              resolve.isPending && event.preventDefault()
            }
            onPointerDownOutside={(event) =>
              resolve.isPending && event.preventDefault()
            }
            onCloseAutoFocus={(event) => {
              // The trigger unmounts with the resolved block, so the route
              // decides where focus lands instead.
              if (!resolvedRef.current || !onResolved) return;
              event.preventDefault();
              onResolved();
            }}
          >
            <DialogHeader>
              <DialogTitle>Resolve blocker?</DialogTitle>
              <DialogDescription>
                {taskKey} returns to In progress if an agent still has it
                claimed, otherwise to Ready. {block.created_by.name} will see
                that the blocker was resolved.
              </DialogDescription>
            </DialogHeader>
            {resolve.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {resolveBlockErrorMessage(resolve.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={resolve.isPending}
                onClick={() => changeOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={resolve.isPending || archived}
                onClick={() => resolve.mutate()}
              >
                {resolve.isPending ? "Resolving…" : "Resolve blocker"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </section>
  );
}
