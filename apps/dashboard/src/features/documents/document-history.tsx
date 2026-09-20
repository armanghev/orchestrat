import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
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
  documentId: string;
  path: string;
  currentRevision: DocumentRevision;
  hasUnsavedChanges: boolean;
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
      {open ? <HistoryDialog {...props} /> : null}
    </Dialog>
  );
}

function HistoryDialog({
  api,
  documentId,
  path,
  currentRevision,
  hasUnsavedChanges
}: DocumentHistoryProps) {
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
      <div className="grid min-h-0 grid-cols-1 grid-rows-[minmax(0,10rem)_minmax(0,1fr)] sm:grid-cols-[200px_minmax(0,1fr)] sm:grid-rows-1">
        <aside
          className="min-h-0 overflow-auto border-b p-3 sm:border-r sm:border-b-0"
          aria-label="Document revisions"
        >
          <RevisionList
            revisions={historicalRevisions}
            selectedRevision={selectedRevision}
            onSelect={setSelectedRevisionNumber}
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

  return (
    <div className="space-y-1">
      {revisions.map((revision) => (
        <button
          key={revision.revision_number}
          type="button"
          aria-pressed={selectedRevision === revision.revision_number}
          className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-muted aria-pressed:bg-muted"
          onClick={() => onSelect(revision.revision_number)}
        >
          <span className="font-medium">
            Revision {revision.revision_number}
          </span>{" "}
          <span className="mt-1 block text-xs text-muted-foreground">
            {revision.author.type} ·{" "}
            {new Date(revision.created_at).toLocaleString()}
          </span>
        </button>
      ))}
    </div>
  );
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
