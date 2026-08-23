import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  coordinationKeys,
  documentQueryOptions,
  documentRevisionsQueryOptions,
  documentsQueryOptions
} from "@/features/coordination/query-options";
import { DashboardApiError } from "@/lib/api/client";

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/documents"
)({ component: DocumentsRoute });

function DocumentsRoute() {
  const { projectId } = Route.useParams();
  const { api, project } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const documents = useQuery(documentsQueryOptions(api, projectId));
  if (documents.isPending)
    return <DocumentMessage title="Documents" message="Loading documents…" />;
  if (documents.isError)
    return (
      <DocumentMessage
        title="Documents unavailable"
        message={
          documents.error instanceof DashboardApiError &&
          documents.error.kind === "PERMISSION_DENIED"
            ? "You don’t have permission to view documents."
            : "We couldn’t load documents. Check your connection and try again."
        }
      />
    );
  const selected =
    documents.data.documents.find((item) => item.id === selectedId) ??
    documents.data.documents[0];
  return (
    <main
      id="main-content"
      className="mx-auto w-full max-w-6xl p-6 md:p-8"
      aria-labelledby="documents-heading"
    >
      <h1
        id="documents-heading"
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight"
      >
        Documents
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Shared Markdown files and immutable revisions.
      </p>
      {project?.project.status === "archived" ? (
        <p className="mt-5 rounded border px-3 py-2 text-sm text-muted-foreground">
          This project is archived and read-only.
        </p>
      ) : null}
      {documents.data.documents.length === 0 ? (
        <p className="mt-8 rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
          No Markdown documents are available yet.
        </p>
      ) : (
        <div className="mt-8 grid gap-6 lg:grid-cols-[240px_1fr]">
          <nav aria-label="Project documents" className="rounded border p-2">
            {documents.data.documents.map((document) => (
              <button
                type="button"
                key={document.id}
                onClick={() => setSelectedId(document.id)}
                className={`w-full rounded px-3 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${selected?.id === document.id ? "bg-muted" : ""}`}
                aria-current={selected?.id === document.id ? "page" : undefined}
              >
                {document.path}
                <span className="mt-1 block text-xs text-muted-foreground">
                  Revision {document.current_revision}
                </span>
              </button>
            ))}
          </nav>
          {selected ? (
            <DocumentEditor
              key={selected.id}
              api={api}
              documentId={selected.id}
              archived={project?.project.status === "archived"}
              queryClient={queryClient}
            />
          ) : null}
        </div>
      )}
    </main>
  );
}

function DocumentEditor({
  api,
  documentId,
  archived,
  queryClient
}: {
  api: Parameters<typeof documentsQueryOptions>[0];
  documentId: string;
  archived: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const document = useQuery(documentQueryOptions(api, documentId));
  const revisions = useQuery(documentRevisionsQueryOptions(api, documentId));
  const [draft, setDraft] = useState("");
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [retryRevision, setRetryRevision] = useState<number | null>(null);
  const [historyRevision, setHistoryRevision] = useState<number | null>(null);
  useEffect(() => {
    if (document.data && loadedRevision === null) {
      setDraft(document.data.revision.content);
      setLoadedRevision(document.data.revision.revision_number);
    }
  }, [document.data, loadedRevision]);
  const save = useMutation({
    mutationFn: () =>
      api.updateDocument(documentId, {
        content: draft,
        base_revision: retryRevision ?? loadedRevision ?? 1
      }),
    onSuccess: async (result) => {
      setConflict(null);
      setRetryRevision(null);
      setDraft(result.revision.content);
      setLoadedRevision(result.revision.revision_number);
      await queryClient.invalidateQueries({
        queryKey: coordinationKeys.documents(result.document.project_id)
      });
      await queryClient.invalidateQueries({
        queryKey: coordinationKeys.document(documentId)
      });
      await queryClient.invalidateQueries({
        queryKey: coordinationKeys.revisions(documentId)
      });
    },
    onError: async (error) => {
      if (
        error instanceof DashboardApiError &&
        error.kind === "DOCUMENT_CONFLICT"
      ) {
        const currentRevision =
          typeof error.details.current_revision === "number"
            ? error.details.current_revision
            : null;
        setRetryRevision(currentRevision);
        setConflict(
          `Document changed on the server. Your draft is preserved; current revision is ${currentRevision ?? "newer"}. Review it, then explicitly retry saving.`
        );
        await queryClient.invalidateQueries({
          queryKey: coordinationKeys.document(documentId)
        });
        await queryClient.invalidateQueries({
          queryKey: coordinationKeys.revisions(documentId)
        });
      } else
        setConflict(
          error instanceof Error
            ? error.message
            : "Unable to save this document."
        );
    }
  });
  if (document.isPending)
    return (
      <p
        role="status"
        className="rounded border p-6 text-sm text-muted-foreground"
      >
        Loading document…
      </p>
    );
  if (document.isError)
    return (
      <p role="alert" className="rounded border p-6 text-sm text-destructive">
        Unable to load this document.
      </p>
    );
  const oldRevision = revisions.data?.revisions.find(
    (item) => item.revision_number === historyRevision
  );
  return (
    <section
      className="rounded border p-5"
      aria-labelledby="document-editor-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="document-editor-heading" className="text-lg font-semibold">
            {document.data.document.path}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Loaded revision {loadedRevision} · current server revision{" "}
            {document.data.document.current_revision}
          </p>
        </div>
        <Button
          onClick={() => save.mutate()}
          disabled={archived || save.isPending}
        >
          {save.isPending
            ? "Saving…"
            : conflict
              ? "Retry save"
              : "Save document"}
        </Button>
      </div>
      {conflict ? (
        <p
          role="alert"
          className="mt-4 rounded border border-amber-500/50 px-3 py-2 text-sm"
        >
          {conflict}
        </p>
      ) : null}
      <label
        htmlFor="document-content"
        className="mt-5 block text-sm font-medium"
      >
        Markdown content
      </label>
      <textarea
        id="document-content"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={archived || save.isPending}
        rows={16}
        className="mt-2 w-full rounded-lg border border-input bg-transparent p-3 font-mono text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      {revisions.data ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold">Revision history</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {revisions.data.revisions.map((revision) => (
              <Button
                key={revision.id}
                variant={
                  historyRevision === revision.revision_number
                    ? "secondary"
                    : "outline"
                }
                size="sm"
                onClick={() => setHistoryRevision(revision.revision_number)}
              >
                Revision {revision.revision_number}
              </Button>
            ))}
          </div>
          {oldRevision ? (
            <div className="mt-4">
              <label htmlFor="old-revision" className="text-sm font-medium">
                Revision {oldRevision.revision_number} (read-only)
              </label>
              <textarea
                id="old-revision"
                value={oldRevision.content}
                readOnly
                rows={8}
                className="mt-2 w-full rounded-lg border border-input bg-muted/30 p-3 font-mono text-sm"
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function DocumentMessage({
  title,
  message
}: {
  title: string;
  message: string;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl p-6 md:p-8">
      <h1 tabIndex={-1} className="text-2xl font-semibold">
        {title}
      </h1>
      <p role="status" className="mt-3 text-sm text-muted-foreground">
        {message}
      </p>
    </main>
  );
}
