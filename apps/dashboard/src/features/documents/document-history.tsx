import { useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import { HistoryIcon } from "lucide-react";
import type { DocumentRevision } from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { coordinationKeys } from "@/features/coordination/query-options";
import type { ApiClient, DocumentRevisionSummary } from "@/lib/api/client";
import { DocumentDiff } from "./document-diff";

export type DocumentHistoryProps = {
  api: ApiClient;
  projectId: string;
  documentId: string;
  path: string;
  currentRevision: DocumentRevision;
  hasUnsavedChanges: boolean;
  readOnly: boolean;
};

export function DocumentHistory(props: DocumentHistoryProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <HistoryIcon data-icon="inline-start" />
          History
        </Button>
      </DialogTrigger>
      {open ? (
        <HistoryDialog {...props} onRestored={() => setOpen(false)} />
      ) : null}
    </Dialog>
  );
}

function HistoryDialog({
  api,
  projectId,
  documentId,
  path,
  currentRevision,
  hasUnsavedChanges,
  readOnly,
  onRestored
}: DocumentHistoryProps & { onRestored: () => void }) {
  const queryClient = useQueryClient();
  const [selectedRevisionNumber, setSelectedRevisionNumber] = useState<
    number | null
  >(null);
  const history = useInfiniteQuery({
    queryKey: [...coordinationKeys.revisionSummary(documentId), "infinite"],
    queryFn: ({ pageParam }) =>
      api.listDocumentRevisionSummaries(documentId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined
  });
  const revisions = useMemo(
    () =>
      Array.from(
        new Map(
          (history.data?.pages.flatMap((page) => page.revisions) ?? []).map(
            (revision) => [revision.revision_number, revision]
          )
        ).values()
      )
        .filter(
          (revision) =>
            revision.revision_number <= currentRevision.revision_number
        )
        .sort((a, b) => b.revision_number - a.revision_number),
    [history.data, currentRevision.revision_number]
  );
  const historicalRevisions = revisions.filter(
    (revision) => revision.revision_number < currentRevision.revision_number
  );

  const selectedRevision =
    selectedRevisionNumber ?? historicalRevisions[0]?.revision_number ?? null;

  const detail = useQuery({
    queryKey: [
      ...coordinationKeys.revisionSummary(documentId),
      "detail",
      selectedRevision
    ],
    queryFn: () => api.getDocumentRevision(documentId, selectedRevision!),
    enabled: selectedRevision !== null
  });
  const restore = useMutation({
    mutationFn: () => {
      if (!detail.data) throw new Error("This revision is not available yet.");
      return api.updateDocument(documentId, {
        content: detail.data.content,
        base_revision: currentRevision.revision_number
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: coordinationKeys.documents(projectId)
        }),
        queryClient.invalidateQueries({
          queryKey: coordinationKeys.document(documentId)
        }),
        queryClient.invalidateQueries({
          queryKey: coordinationKeys.revisions(documentId)
        })
      ]);
      onRestored();
    }
  });
  const restoreBlockedReason = hasUnsavedChanges
    ? "Save or discard your draft before restoring a revision."
    : readOnly
      ? "Archived documents are read-only."
      : undefined;

  return (
    <DialogContent className="document-history-dialog h-[min(80dvh,760px)] w-[calc(100vw-2rem)] max-w-[1100px] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 sm:max-w-[1100px]">
      <DialogHeader className="border-b px-5 py-4 pr-12">
        <DialogTitle>Document history</DialogTitle>
        <DialogDescription className="truncate">{path}</DialogDescription>
        {hasUnsavedChanges ? (
          <p className="text-xs text-muted-foreground">
            Unsaved draft changes are excluded. Comparisons use the current
            saved version.
          </p>
        ) : null}
      </DialogHeader>
      <div className="grid min-h-0 grid-cols-1 grid-rows-[minmax(0,10rem)_minmax(0,1fr)] sm:grid-cols-[260px_minmax(0,1fr)] sm:grid-rows-1">
        <aside
          className="min-h-0 overflow-auto border-b p-3 sm:border-r sm:border-b-0"
          aria-label="Document revisions"
        >
          <RevisionList
            revisions={historicalRevisions}
            selectedRevision={selectedRevision}
            onSelect={(revision) => {
              restore.reset();
              setSelectedRevisionNumber(revision);
            }}
            loading={history.isPending}
            error={history.isError && !history.data}
            onRetry={() => history.refetch()}
          />
          {history.isFetchNextPageError ? (
            <Button
              className="mt-2 w-full"
              variant="outline"
              size="sm"
              onClick={() => history.fetchNextPage()}
            >
              Retry older revisions
            </Button>
          ) : history.hasNextPage ? (
            <Button
              className="mt-2 w-full"
              variant="outline"
              size="sm"
              disabled={history.isFetchingNextPage}
              onClick={() => history.fetchNextPage()}
            >
              {history.isFetchingNextPage ? "Loading…" : "Load older revisions"}
            </Button>
          ) : null}
        </aside>
        <section
          className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 overflow-hidden p-4"
          aria-live="polite"
        >
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {selectedRevision === null
                  ? "Select a revision"
                  : `Revision ${selectedRevision}`}
              </span>
              <span>vs</span>
              <span className="font-medium text-foreground">
                Current saved · Revision {currentRevision.revision_number}
              </span>
              <span>
                <span className="mr-1 inline-block size-2 rounded-sm bg-destructive/45" />
                Removed
              </span>
              <span>
                <span className="mr-1 inline-block size-2 rounded-sm bg-success/45" />
                Added
              </span>
              <Button
                className="ml-auto"
                size="sm"
                disabled={
                  selectedRevision === null ||
                  !detail.data ||
                  restore.isPending ||
                  Boolean(restoreBlockedReason)
                }
                title={restoreBlockedReason}
                onClick={() => restore.mutate()}
              >
                {restore.isPending ? "Restoring…" : "Restore as new revision"}
              </Button>
            </div>
            {restore.isError ? (
              <p role="alert" className="text-xs text-destructive">
                {restore.error instanceof Error
                  ? restore.error.message
                  : "Unable to restore this revision."}
              </p>
            ) : null}
          </div>
          {detail.isPending && selectedRevision !== null ? (
            <Skeleton className="h-full min-h-64" />
          ) : detail.isError ? (
            <ErrorState
              label="Could not load this revision."
              onRetry={() => detail.refetch()}
            />
          ) : detail.data?.content === currentRevision.content ? (
            <p className="place-self-center text-sm text-muted-foreground">
              No changes from the current version.
            </p>
          ) : detail.data ? (
            <DocumentDiff
              original={detail.data.content}
              current={currentRevision.content}
            />
          ) : (
            <p className="place-self-center text-sm text-muted-foreground">
              {history.isPending
                ? "Loading history…"
                : "No earlier revisions to compare."}
            </p>
          )}
        </section>
      </div>
    </DialogContent>
  );
}

function RevisionList({
  revisions,
  selectedRevision,
  onSelect,
  loading,
  error,
  onRetry
}: {
  revisions: DocumentRevisionSummary[];
  selectedRevision: number | null;
  onSelect: (revision: number) => void;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  if (loading)
    return (
      <div className="space-y-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  if (error)
    return <ErrorState label="Could not load history." onRetry={onRetry} />;
  if (revisions.length === 0)
    return (
      <p className="p-2 text-sm text-muted-foreground">
        No revision history yet.
      </p>
    );

  const groups = Array.from(
    revisions.reduce((grouped, revision) => {
      const date = new Date(revision.created_at);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const group = grouped.get(key);
      if (group) group.revisions.push(revision);
      else grouped.set(key, { date, revisions: [revision] });
      return grouped;
    }, new Map<string, { date: Date; revisions: DocumentRevisionSummary[] }>())
  ).map(([, group]) => group);

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.date.toISOString()}>
          <h3 className="mb-2 px-1 text-xs font-medium text-muted-foreground">
            {formatRevisionDay(group.date)}
          </h3>
          <ol
            className="relative ml-2 border-l border-border pl-4"
            aria-label={`${formatRevisionDay(group.date)} revisions`}
          >
            {group.revisions.map((revision) => {
              const selected = selectedRevision === revision.revision_number;
              const createdAt = new Date(revision.created_at);
              const time = createdAt.toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit"
              });
              return (
                <li key={revision.revision_number} className="relative py-0.5">
                  <span
                    aria-hidden="true"
                    className={`absolute -left-[1.3rem] top-4 size-2.5 rounded-full border-2 border-background ${selected ? "bg-primary" : "bg-muted-foreground/45"}`}
                  />
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-label={`Revision ${revision.revision_number}, ${time}, ${revision.author.type} edit`}
                    className="w-full rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted aria-pressed:bg-muted"
                    onClick={() => onSelect(revision.revision_number)}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-medium text-foreground">
                        Revision {revision.revision_number}
                      </span>
                      <time
                        className="shrink-0 text-xs text-muted-foreground"
                        dateTime={revision.created_at}
                      >
                        {time}
                      </time>
                    </span>
                    <span className="mt-1 block text-xs capitalize text-muted-foreground">
                      {revision.author.type} edit
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

function formatRevisionDay(date: Date) {
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric"
  });
}

function ErrorState({
  label,
  onRetry
}: {
  label: string;
  onRetry: () => void;
}) {
  return (
    <div className="grid place-items-center gap-2 p-4 text-center text-sm text-muted-foreground">
      <p>{label}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
