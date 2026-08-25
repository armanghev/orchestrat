import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  coordinationKeys,
  documentAttachmentsQueryOptions,
  documentQueryOptions,
  documentRevisionSummaryQueryOptions,
  documentsQueryOptions
} from "@/features/coordination/query-options";
import {
  DashboardApiError,
  type DocumentAttachment,
  type DocumentAttachmentUpload
} from "@/lib/api/client";

const AUTOSAVE_DELAY_MS = 1_500;
const PART_SIZE_BYTES = 16 * 1024 * 1024;
const PART_SIGN_BATCH_SIZE = 100;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/documents"
)({ component: DocumentsRoute });

type RemoteRevision = { revision: number; content: string; actor: string };

function DocumentsRoute() {
  const { projectId } = Route.useParams();
  const { api, project } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [creating, setCreating] = useState(false);
  const documents = useQuery(documentsQueryOptions(api, projectId));
  const create = useMutation({
    mutationFn: () =>
      api.createDocument(projectId, { path: newPath, content: "" }),
    onSuccess: async (result) => {
      setNewPath("");
      setCreating(false);
      setSelectedId(result.document.id);
      await queryClient.invalidateQueries({
        queryKey: coordinationKeys.documents(projectId)
      });
    }
  });

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

  const active = documents.data.documents.filter(
    (item) => !("archived_at" in item) || !item.archived_at
  );
  const archived = documents.data.documents.filter(
    (item) => "archived_at" in item && Boolean(item.archived_at)
  );
  const visible = showArchived ? archived : active;
  const selected =
    visible.find((item) => item.id === selectedId) ?? visible[0] ?? null;
  const projectArchived = project?.project.status === "archived";
  return (
    <main
      id="main-content"
      className="mx-auto w-full max-w-6xl p-6 md:p-8"
      aria-labelledby="documents-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
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
        </div>
        {!projectArchived ? (
          creating ? (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (newPath.trim()) create.mutate();
              }}
            >
              <Input
                aria-label="New document path"
                value={newPath}
                onChange={(event) => setNewPath(event.target.value)}
                placeholder="notes/idea.md"
                disabled={create.isPending}
              />
              <Button
                type="submit"
                disabled={!newPath.trim() || create.isPending}
              >
                {create.isPending ? "Creating…" : "Create"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCreating(false)}
                disabled={create.isPending}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <Button onClick={() => setCreating(true)}>New document</Button>
          )
        ) : null}
      </div>
      {create.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {create.error instanceof Error
            ? create.error.message
            : "Unable to create the document."}
        </p>
      ) : null}
      {projectArchived ? (
        <p className="mt-5 rounded border px-3 py-2 text-sm text-muted-foreground">
          This project is archived and read-only.
        </p>
      ) : null}
      <div className="mt-6 flex gap-2" role="group" aria-label="Document state">
        <Button
          variant={!showArchived ? "secondary" : "outline"}
          size="sm"
          onClick={() => setShowArchived(false)}
        >
          Active ({active.length})
        </Button>
        <Button
          variant={showArchived ? "secondary" : "outline"}
          size="sm"
          onClick={() => setShowArchived(true)}
        >
          Archived ({archived.length})
        </Button>
      </div>
      {visible.length === 0 ? (
        <p className="mt-6 rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
          {showArchived
            ? "No archived documents."
            : "No Markdown documents are available yet."}
        </p>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
          <nav aria-label="Project documents" className="rounded border p-2">
            {visible.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => setSelectedId(item.id)}
                className={`w-full rounded px-3 py-2 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${selected?.id === item.id ? "bg-muted" : ""}`}
                aria-current={selected?.id === item.id ? "page" : undefined}
              >
                {item.path}
                <span className="mt-1 block font-mono text-xs text-muted-foreground">
                  Revision {item.current_revision}
                </span>
              </button>
            ))}
          </nav>
          {selected ? (
            <DocumentEditor
              key={selected.id}
              api={api}
              projectId={projectId}
              documentId={selected.id}
              projectArchived={projectArchived}
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
  projectId,
  documentId,
  projectArchived,
  queryClient
}: {
  api: Parameters<typeof documentsQueryOptions>[0];
  projectId: string;
  documentId: string;
  projectArchived: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const document = useQuery(documentQueryOptions(api, documentId));
  const history = useQuery(
    documentRevisionSummaryQueryOptions(api, documentId)
  );
  const attachments = useQuery(
    documentAttachmentsQueryOptions(api, documentId)
  );
  const [draft, setDraft] = useState("");
  const [baseContent, setBaseContent] = useState("");
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [remote, setRemote] = useState<RemoteRevision | null>(null);
  const [awaitingRemote, setAwaitingRemote] = useState(false);
  const [merging, setMerging] = useState(false);
  const [status, setStatus] = useState("Saved");
  const [rename, setRename] = useState(false);
  const [path, setPath] = useState("");
  const [historyRevision, setHistoryRevision] = useState<number | null>(null);
  const draftRef = useRef(draft);
  const baseContentRef = useRef(baseContent);
  const baseRevisionRef = useRef(baseRevision);
  const remoteRef = useRef(remote);
  const awaitingRemoteRef = useRef(awaitingRemote);
  const savingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    draftRef.current = draft;
    baseContentRef.current = baseContent;
    baseRevisionRef.current = baseRevision;
    remoteRef.current = remote;
    awaitingRemoteRef.current = awaitingRemote;
  }, [awaitingRemote, baseContent, baseRevision, draft, remote]);
  const invalidateDocument = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: coordinationKeys.documents(projectId)
      }),
      queryClient.invalidateQueries({
        queryKey: coordinationKeys.document(documentId)
      }),
      queryClient.invalidateQueries({
        queryKey: coordinationKeys.revisions(documentId)
      }),
      queryClient.invalidateQueries({
        queryKey: coordinationKeys.attachments(documentId)
      })
    ]);
  }, [documentId, projectId, queryClient]);
  const save = useMutation({
    mutationFn: (input: {
      content: string;
      base_revision: number;
      save_kind?: "autosave";
    }) => api.updateDocument(documentId, input),
    onSuccess: async (result, input) => {
      savingRef.current = false;
      const revision = result.revision.revision_number;
      const newerRemote =
        remoteRef.current && remoteRef.current.revision > revision
          ? remoteRef.current
          : null;
      baseContentRef.current = result.revision.content;
      baseRevisionRef.current = revision;
      setBaseContent(result.revision.content);
      setBaseRevision(revision);
      if (newerRemote) {
        awaitingRemoteRef.current = false;
        setAwaitingRemote(false);
        setRemote(newerRemote);
        setStatus(
          `Revision ${newerRemote.revision} saved by ${newerRemote.actor}; your draft is preserved.`
        );
      } else {
        awaitingRemoteRef.current = false;
        setAwaitingRemote(false);
        remoteRef.current = null;
        setRemote(null);
        setMerging(false);
        setStatus(
          draftRef.current === input.content
            ? `Saved revision ${revision}`
            : "Unsaved"
        );
      }
      await invalidateDocument();
    },
    onError: async (error) => {
      savingRef.current = false;
      if (
        error instanceof DashboardApiError &&
        error.kind === "DOCUMENT_CONFLICT"
      ) {
        awaitingRemoteRef.current = true;
        setAwaitingRemote(true);
        setStatus(
          "Revision changed remotely. Resolve the conflict before saving."
        );
        await queryClient.invalidateQueries({
          queryKey: coordinationKeys.document(documentId)
        });
        await queryClient.invalidateQueries({
          queryKey: coordinationKeys.revisions(documentId)
        });
        return;
      }
      if (
        error instanceof DashboardApiError &&
        error.kind === "NETWORK_ERROR"
      ) {
        setStatus("Offline, retrying");
        return;
      }
      setStatus(
        error instanceof Error ? error.message : "Unable to save this document."
      );
    }
  });
  const saveNow = useCallback(
    (expectedRevision = baseRevisionRef.current, saveKind?: "autosave") => {
      if (
        savingRef.current ||
        expectedRevision === null ||
        draftRef.current === baseContentRef.current ||
        remoteRef.current !== null ||
        awaitingRemoteRef.current ||
        projectArchived
      )
        return;
      savingRef.current = true;
      setStatus("Saving…");
      save.mutate({
        content: draftRef.current,
        base_revision: expectedRevision,
        ...(saveKind ? { save_kind: saveKind } : {})
      });
    },
    [projectArchived, save]
  );
  useEffect(() => {
    const next = document.data;
    if (!next) return;
    const revision = next.revision.revision_number;
    const content = next.revision.content;
    if (baseRevisionRef.current === null) {
      draftRef.current = content;
      baseContentRef.current = content;
      baseRevisionRef.current = revision;
      setDraft(content);
      setBaseContent(content);
      setBaseRevision(revision);
      setPath(next.document.path);
      setStatus(`Saved revision ${revision}`);
      return;
    }
    if (revision <= baseRevisionRef.current) return;
    const actor = `${next.revision.author.type} ${next.revision.author.id}`;
    if (
      !savingRef.current &&
      draftRef.current === baseContentRef.current &&
      remoteRef.current === null
    ) {
      draftRef.current = content;
      baseContentRef.current = content;
      baseRevisionRef.current = revision;
      setDraft(content);
      setBaseContent(content);
      setBaseRevision(revision);
      setStatus(`Revision ${revision} saved by ${actor}`);
      return;
    }
    const target = { revision, content, actor };
    remoteRef.current = target;
    awaitingRemoteRef.current = false;
    setAwaitingRemote(false);
    setRemote(target);
    setStatus(
      `Revision ${revision} saved by ${actor}; your draft is preserved.`
    );
  }, [document.data]);
  const archived =
    projectArchived ||
    Boolean(
      (document.data?.document as { archived_at?: string | null } | undefined)
        ?.archived_at
    );
  const dirty = draft !== baseContent;
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (
      !dirty ||
      remote ||
      awaitingRemote ||
      merging ||
      archived ||
      save.isPending
    )
      return;
    timerRef.current = setTimeout(
      () => saveNow(baseRevisionRef.current, "autosave"),
      AUTOSAVE_DELAY_MS
    );
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [
    archived,
    awaitingRemote,
    dirty,
    draft,
    merging,
    remote,
    save.isPending,
    saveNow
  ]);
  if (document.isPending)
    return (
      <p
        role="status"
        className="rounded border p-6 text-sm text-muted-foreground"
      >
        Loading document…
      </p>
    );
  if (document.isError || !document.data)
    return (
      <p role="alert" className="rounded border p-6 text-sm text-destructive">
        Unable to load this document.
      </p>
    );
  const current = document.data;
  const renameDocument = async () => {
    if (!path.trim() || baseRevision === null) return;
    const result = await api.renameDocument(documentId, {
      path: path.trim(),
      expected_revision: baseRevision
    });
    setPath(result.document.path);
    setRename(false);
    await invalidateDocument();
  };
  return (
    <section
      className="min-w-0 rounded border p-5"
      aria-labelledby="document-editor-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {rename && !archived ? (
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label="Document path"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
              <Button size="sm" onClick={() => void renameDocument()}>
                Rename
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRename(false);
                  setPath(current.document.path);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <h2
              id="document-editor-heading"
              className="truncate text-lg font-semibold"
            >
              {current.document.path}
            </h2>
          )}
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            Revision {baseRevision ?? current.revision.revision_number}
            {archived ? " · archived" : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!archived && !rename ? (
            <Button variant="outline" size="sm" onClick={() => setRename(true)}>
              Rename
            </Button>
          ) : null}
          {archived && !projectArchived ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void api.restoreDocument(documentId).then(invalidateDocument)
              }
            >
              Restore
            </Button>
          ) : null}
          {!archived ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void api.archiveDocument(documentId).then(invalidateDocument)
              }
            >
              Archive
            </Button>
          ) : null}
          {!archived ? (
            <Button
              onClick={() => saveNow()}
              disabled={!dirty || save.isPending || Boolean(remote) || merging}
            >
              {save.isPending ? "Saving…" : "Save now"}
            </Button>
          ) : null}
        </div>
      </div>
      <p
        role="status"
        aria-live="polite"
        className="mt-3 text-sm text-muted-foreground"
      >
        {status}
      </p>
      {remote ? (
        <div
          className="mt-4 rounded border border-amber-500/50 p-3"
          role="alert"
          aria-labelledby="conflict-heading"
        >
          <h3 id="conflict-heading" className="font-medium">
            Revision conflict
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Revision {remote.revision} was saved by {remote.actor}. Autosave is
            paused until you decide.
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-sm font-medium">
              Your draft
              <textarea
                value={draft}
                readOnly
                rows={8}
                className="mt-1 w-full rounded border bg-muted/30 p-2 font-mono text-xs"
              />
            </label>
            <label className="text-sm font-medium">
              Remote revision {remote.revision}
              <textarea
                value={remote.content}
                readOnly
                rows={8}
                className="mt-1 w-full rounded border bg-muted/30 p-2 font-mono text-xs"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                remoteRef.current = null;
                awaitingRemoteRef.current = false;
                setAwaitingRemote(false);
                draftRef.current = remote.content;
                baseContentRef.current = remote.content;
                baseRevisionRef.current = remote.revision;
                setDraft(remote.content);
                setBaseContent(remote.content);
                setBaseRevision(remote.revision);
                setRemote(null);
                setMerging(false);
                setStatus(`Saved revision ${remote.revision}`);
              }}
            >
              Use remote
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                remoteRef.current = null;
                awaitingRemoteRef.current = false;
                setAwaitingRemote(false);
                baseContentRef.current = remote.content;
                baseRevisionRef.current = remote.revision;
                setBaseContent(remote.content);
                setBaseRevision(remote.revision);
                setMerging(true);
                setRemote(null);
                setStatus(
                  "Merging locally. Autosave is paused; save explicitly when ready."
                );
              }}
            >
              Continue merging
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const target = remote;
                remoteRef.current = null;
                awaitingRemoteRef.current = false;
                setAwaitingRemote(false);
                setRemote(null);
                setMerging(true);
                saveNow(target.revision);
              }}
              disabled={save.isPending}
            >
              Save mine
            </Button>
          </div>
        </div>
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
        onChange={(event) => {
          setDraft(event.target.value);
          if (!remote && !merging) setStatus("Unsaved");
        }}
        disabled={archived}
        rows={16}
        className="mt-2 w-full rounded-lg border border-input bg-transparent p-3 font-mono text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
      />
      {merging && !remote && !archived ? (
        <div className="mt-3 flex items-center gap-2">
          <p className="text-sm text-amber-500">
            Autosave is paused while merging.
          </p>
          <Button
            size="sm"
            onClick={() => saveNow(baseRevision)}
            disabled={!dirty || save.isPending}
          >
            Save mine
          </Button>
        </div>
      ) : null}
      <AttachmentSection
        api={api}
        documentId={documentId}
        archived={archived}
        attachments={attachments.data?.attachments ?? []}
        onChanged={invalidateDocument}
      />
      <section
        className="mt-6 border-t pt-5"
        aria-labelledby="revision-history-heading"
      >
        <h3 id="revision-history-heading" className="text-sm font-semibold">
          Revision history
        </h3>
        {history.isError ? (
          <p className="mt-2 text-sm text-destructive">
            Unable to load revision history.
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2">
          {history.data?.revisions.map((revision) => (
            <Button
              key={revision.revision_number}
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
        {historyRevision ? (
          <HistoricalRevision
            api={api}
            documentId={documentId}
            revision={historyRevision}
          />
        ) : null}
      </section>
    </section>
  );
}

function HistoricalRevision({
  api,
  documentId,
  revision
}: {
  api: Parameters<typeof documentsQueryOptions>[0];
  documentId: string;
  revision: number;
}) {
  const detail = useQuery({
    queryKey: [...coordinationKeys.revisions(documentId), "detail", revision],
    queryFn: () => api.getDocumentRevision(documentId, revision)
  });
  if (detail.isPending)
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        Loading revision {revision}…
      </p>
    );
  if (detail.isError || !detail.data)
    return (
      <p className="mt-3 text-sm text-destructive">
        Unable to load revision {revision}.
      </p>
    );
  return (
    <label className="mt-4 block text-sm font-medium">
      Revision {revision} (read-only)
      <textarea
        value={detail.data.content}
        readOnly
        rows={8}
        className="mt-2 w-full rounded-lg border border-input bg-muted/30 p-3 font-mono text-sm"
      />
    </label>
  );
}

type AttachmentUploadState = {
  file: File;
  session?: DocumentAttachmentUpload;
  mode?: "single" | "multipart";
  progress: number;
  message: string;
  uploadId?: string;
  paused?: boolean;
  failed?: boolean;
  complete?: boolean;
};

function AttachmentSection({
  api,
  documentId,
  archived,
  attachments,
  onChanged
}: {
  api: Parameters<typeof documentsQueryOptions>[0];
  documentId: string;
  archived: boolean;
  attachments: DocumentAttachment[];
  onChanged: () => Promise<void>;
}) {
  const [uploading, setUploading] = useState<AttachmentUploadState | null>(
    null
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const pausedRef = useRef(false);
  const resumeWaitersRef = useRef(new Set<() => void>());
  const waitForResume = () => {
    if (!pausedRef.current) return Promise.resolve();
    return new Promise<void>((resolve) =>
      resumeWaitersRef.current.add(resolve)
    );
  };
  const setPaused = (paused: boolean) => {
    pausedRef.current = paused;
    setUploading((current) =>
      current
        ? {
            ...current,
            paused,
            message: paused ? "Paused" : "Uploading…"
          }
        : current
    );
    if (!paused) {
      for (const resolve of resumeWaitersRef.current) resolve();
      resumeWaitersRef.current.clear();
    }
  };
  const upload = async (
    file: File,
    previousSession?: DocumentAttachmentUpload
  ) => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setUploading({
        file,
        progress: 0,
        message: "Attachments are limited to 2 GiB.",
        failed: true
      });
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    pausedRef.current = false;
    let session = previousSession;
    setUploading({
      file,
      session,
      mode: session?.mode,
      progress: 0,
      message: session ? "Resuming upload…" : "Starting upload…",
      uploadId: session?.id
    });
    try {
      if (session) {
        session = (
          await api.getDocumentAttachmentUpload(documentId, session.id)
        ).upload;
        if (session.mode === "single" && !session.upload_url)
          session = (
            await api.refreshDocumentAttachmentUpload(documentId, session.id)
          ).upload;
      } else {
        session = (
          await api.startDocumentAttachmentUpload(documentId, {
            filename: file.name,
            content_type: file.type || "application/octet-stream",
            size_bytes: file.size
          })
        ).upload;
      }
      setUploading({
        file,
        session,
        mode: session.mode,
        progress: 0,
        message: "Uploading…",
        uploadId: session.id
      });
      if (session.mode === "single") {
        if (!session.upload_url)
          throw new Error("Upload session is missing its upload URL.");
        await api.putPresignedObject(
          session.upload_url,
          file,
          (loaded) =>
            setUploading((current) =>
              current
                ? {
                    ...current,
                    progress: attachmentProgress(loaded, file.size),
                    message: "Uploading…"
                  }
                : current
            ),
          controller.signal
        );
        await api.completeDocumentAttachmentUpload(documentId, session.id);
      } else if (session.mode === "multipart")
        await uploadMultipart(
          api,
          documentId,
          session,
          file,
          (progress) =>
            setUploading((current) =>
              current
                ? {
                    ...current,
                    progress,
                    message: pausedRef.current ? "Paused" : "Uploading…"
                  }
                : current
            ),
          controller.signal,
          waitForResume
        );
      else throw new Error("Upload mode does not match the attachment size.");
      setUploading({
        file,
        session,
        mode: session.mode,
        progress: 1,
        message: "Complete",
        uploadId: session.id,
        complete: true
      });
      await onChanged();
    } catch (error) {
      if (controller.signal.aborted) {
        setUploading(null);
        return;
      }
      setUploading((current) =>
        current
          ? {
              ...current,
              session: current.session ?? session,
              mode: current.mode ?? session?.mode,
              uploadId: current.uploadId ?? session?.id,
              message:
                error instanceof Error ? error.message : "Upload failed.",
              failed: true,
              paused: false
            }
          : {
              file,
              session,
              mode: session?.mode,
              progress: 0,
              uploadId: session?.id,
              message:
                error instanceof Error ? error.message : "Upload failed.",
              failed: true
            }
      );
    }
  };
  const canChooseAttachment =
    !uploading ||
    uploading.complete ||
    (uploading.failed && !uploading.uploadId);
  return (
    <section
      className="mt-6 border-t pt-5"
      aria-labelledby="attachments-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="attachments-heading" className="text-sm font-semibold">
            Attachments
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Private files are downloaded as attachments.
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.currentTarget.value = "";
          }}
          disabled={archived || !canChooseAttachment}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={archived || !canChooseAttachment}
          onClick={() => inputRef.current?.click()}
        >
          Add attachment
        </Button>
      </div>
      {uploading ? (
        <div className="mt-3 rounded border p-3" role="status">
          <div className="flex justify-between gap-3 text-sm">
            <span className="truncate">{uploading.file.name}</span>
            <span>{Math.round(uploading.progress * 100)}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-primary"
              style={{ width: `${uploading.progress * 100}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {uploading.message}
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            {uploading.mode === "multipart" &&
            !uploading.failed &&
            !uploading.complete ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPaused(!uploading.paused)}
              >
                {uploading.paused ? "Resume" : "Pause"}
              </Button>
            ) : null}
            {uploading.failed ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void upload(uploading.file, uploading.session)}
              >
                Retry
              </Button>
            ) : null}
            {uploading.failed && !uploading.uploadId ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setUploading(null)}
              >
                Dismiss
              </Button>
            ) : null}
            {uploading.uploadId && !uploading.complete ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void (async () => {
                    controllerRef.current?.abort();
                    setPaused(false);
                    try {
                      await api.abortDocumentAttachmentUpload(
                        documentId,
                        uploading.uploadId!
                      );
                    } finally {
                      setUploading(null);
                    }
                  })()
                }
              >
                Abort
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <ul className="mt-3 space-y-2">
        {attachments.map((attachment) => (
          <AttachmentRow
            key={attachment.id}
            api={api}
            documentId={documentId}
            attachment={attachment}
            archived={archived}
            onChanged={onChanged}
          />
        ))}
      </ul>
    </section>
  );
}

export function attachmentProgress(loaded: number, total: number) {
  return total > 0 ? Math.max(0, Math.min(1, loaded / total)) : 0;
}

export async function uploadMultipart(
  api: Parameters<typeof documentsQueryOptions>[0],
  documentId: string,
  session: DocumentAttachmentUpload,
  file: File,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
  waitForResume: () => Promise<void>
) {
  const partSize = session.part_size_bytes ?? PART_SIZE_BYTES;
  const allParts = Array.from(
    { length: Math.ceil(file.size / partSize) },
    (_, index) => index + 1
  );
  const completedParts = new Set(
    (session.completed_parts ?? [])
      .map((part) => part.part_number)
      .filter((partNumber) => allParts.includes(partNumber))
  );
  const pendingParts = allParts.filter(
    (partNumber) => !completedParts.has(partNumber)
  );
  const partProgress = new Map<number, number>();
  const bytesForPart = (partNumber: number) =>
    Math.max(0, Math.min(partSize, file.size - (partNumber - 1) * partSize));
  for (const partNumber of completedParts)
    partProgress.set(partNumber, bytesForPart(partNumber));
  const reportProgress = () => {
    const uploaded = [...partProgress.values()].reduce(
      (total, loaded) => total + loaded,
      0
    );
    onProgress(attachmentProgress(uploaded, file.size));
  };
  reportProgress();
  for (
    let index = 0;
    index < pendingParts.length;
    index += PART_SIGN_BATCH_SIZE
  ) {
    await waitForResume();
    if (signal.aborted) throw new Error("Attachment upload aborted.");
    const partNumbers = pendingParts.slice(index, index + PART_SIGN_BATCH_SIZE);
    const signed = await api.refreshDocumentAttachmentParts(
      documentId,
      session.id,
      partNumbers
    );
    const urls = new Map(
      signed.parts.map((part) => [part.part_number, part.upload_url])
    );
    const batchController = new AbortController();
    const abortBatch = () => batchController.abort();
    if (signal.aborted) abortBatch();
    else signal.addEventListener("abort", abortBatch, { once: true });
    const waitForBatchResume = () => {
      if (batchController.signal.aborted)
        return Promise.reject(new Error("Attachment upload aborted."));
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          reject(new Error("Attachment upload aborted."));
        };
        batchController.signal.addEventListener("abort", onAbort, {
          once: true
        });
        void waitForResume().then(
          () => {
            batchController.signal.removeEventListener("abort", onAbort);
            resolve();
          },
          (error: unknown) => {
            batchController.signal.removeEventListener("abort", onAbort);
            reject(error);
          }
        );
      });
    };
    let nextPart = 0;
    let failure: unknown;
    const workers = Array.from(
      { length: Math.min(4, partNumbers.length) },
      async () => {
        try {
          while (nextPart < partNumbers.length) {
            await waitForBatchResume();
            const partNumber = partNumbers[nextPart++];
            const url = urls.get(partNumber);
            if (!url)
              throw new Error(`Missing upload URL for part ${partNumber}.`);
            const start = (partNumber - 1) * partSize;
            await api.putPresignedObject(
              url,
              file.slice(start, Math.min(file.size, start + partSize)),
              (loaded) => {
                partProgress.set(partNumber, loaded);
                reportProgress();
              },
              batchController.signal
            );
            partProgress.set(partNumber, bytesForPart(partNumber));
            reportProgress();
          }
        } catch (error) {
          failure ??= error;
          batchController.abort();
          throw error;
        }
      }
    );
    await Promise.allSettled(workers);
    signal.removeEventListener("abort", abortBatch);
    if (failure) throw failure;
  }
  await api.completeDocumentAttachmentUpload(documentId, session.id);
}

function AttachmentRow({
  api,
  documentId,
  attachment,
  archived,
  onChanged
}: {
  api: Parameters<typeof documentsQueryOptions>[0];
  documentId: string;
  attachment: DocumentAttachment;
  archived: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-sm">
      <span className="min-w-0 truncate">
        <span className="font-medium">{attachment.filename}</span>
        <span className="ml-2 font-mono text-xs text-muted-foreground">
          {formatBytes(attachment.size_bytes)}
        </span>
      </span>
      <span className="flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void (async () => {
              setBusy(true);
              try {
                const { download_url } = await api.downloadDocumentAttachment(
                  documentId,
                  attachment.id
                );
                window.location.assign(download_url);
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          Download
        </Button>
        {!archived ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  await api.removeDocumentAttachment(documentId, attachment.id);
                  await onChanged();
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            Remove
          </Button>
        ) : null}
      </span>
    </li>
  );
}

function formatBytes(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KiB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
