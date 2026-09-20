import { PageState } from "@/components/dashboard/page";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription
} from "@/components/ui/empty";
import { cn } from "@/lib/cn";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { MDXEditorMethods } from "@mdxeditor/editor";
import type { Document as ProjectDocument } from "@orchestrat/protocol";
import {
  Archive,
  ChevronRight,
  FileText,
  Folder,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TopToolbarActions } from "@/components/app-shell/app-shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { MarkdownEditor } from "@/features/documents/markdown-editor";
import { DocumentHistory } from "@/features/documents/document-history";
import {
  coordinationKeys,
  documentQueryOptions,
  documentsQueryOptions
} from "@/features/coordination/query-options";
import {
  DashboardApiError,
  type DocumentAttachmentUpload
} from "@/lib/api/client";

const AUTOSAVE_DELAY_MS = 1_500;
const PART_SIZE_BYTES = 16 * 1024 * 1024;
const PART_SIGN_BATCH_SIZE = 100;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024 * 1024;
const DOCUMENT_IMAGE_PREFIX = "orchestrat-attachment:";
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/documents"
)({ component: DocumentsRoute });

type RemoteRevision = { revision: number; content: string; actor: string };
type DocumentTreeFolder = {
  type: "folder";
  name: string;
  path: string;
  children: DocumentTreeNode[];
};
type DocumentTreeFile = {
  type: "file";
  name: string;
  document: ProjectDocument;
};
type DocumentTreeNode = DocumentTreeFolder | DocumentTreeFile;

function buildDocumentTree(documents: ProjectDocument[]) {
  const root: DocumentTreeNode[] = [];

  for (const document of documents) {
    const parts = document.path.split("/");
    const name = parts.pop() ?? document.path;
    let children = root;
    let folderPath = "";

    for (const part of parts) {
      folderPath = folderPath ? `${folderPath}/${part}` : part;
      let folder = children.find(
        (node): node is DocumentTreeFolder =>
          node.type === "folder" && node.name === part
      );
      if (!folder) {
        folder = { type: "folder", name: part, path: folderPath, children: [] };
        children.push(folder);
      }
      children = folder.children;
    }

    children.push({ type: "file", name, document });
  }

  const sort = (nodes: DocumentTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    for (const node of nodes) if (node.type === "folder") sort(node.children);
  };
  sort(root);
  return root;
}

function DocumentTree({
  documents,
  selectedId,
  onSelect
}: {
  documents: ProjectDocument[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {buildDocumentTree(documents).map((node) => (
        <DocumentTreeItem
          key={node.type === "folder" ? node.path : node.document.id}
          node={node}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function DocumentTreeItem({
  node,
  selectedId,
  onSelect
}: {
  node: DocumentTreeNode;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (node.type === "folder") {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${node.path} folder`}
          title={node.path}
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90"
            )}
            aria-hidden="true"
          />
          <Folder
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="truncate">{node.name}</span>
        </button>
        {open ? (
          <ul className="ml-3 space-y-0.5 border-l border-border/70 pl-1">
            {node.children.map((child) => (
              <DocumentTreeItem
                key={child.type === "folder" ? child.path : child.document.id}
                node={child}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  const selected = selectedId === node.document.id;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.document.id)}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted",
          selected
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground"
        )}
        aria-current={selected ? "page" : undefined}
        title={node.document.path}
      >
        <FileText className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          r{node.document.current_revision}
        </span>
      </button>
    </li>
  );
}

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
    <div
      className="document-workspace dashboard-page min-h-full"
      aria-label="Project documents"
    >
      <TopToolbarActions>
        {!projectArchived ? (
          creating ? (
            <form
              className="flex items-center gap-2"
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
                className="w-44"
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
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              New document
            </Button>
          )
        ) : null}
      </TopToolbarActions>
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
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border bg-card">
        <div className="grid min-h-0 w-full md:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)]">
          <nav
            aria-label="Project documents"
            className="min-w-0 border-b bg-muted/20 md:border-r md:border-b-0"
          >
            <Tabs
              value={showArchived ? "archived" : "active"}
              onValueChange={(value) => setShowArchived(value === "archived")}
              className="gap-0"
            >
              <div className="border-b p-3">
                <TabsList aria-label="Document state">
                  <TabsTrigger value="active">
                    Active ({active.length})
                  </TabsTrigger>
                  <TabsTrigger value="archived">
                    Archived ({archived.length})
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value={showArchived ? "archived" : "active"}>
                <div className="max-h-40 flex flex-col gap-1 overflow-y-auto p-2 md:max-h-[70dvh]">
                  <DocumentTree
                    documents={visible}
                    selectedId={selected?.id}
                    onSelect={setSelectedId}
                  />
                </div>
              </TabsContent>
            </Tabs>
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
          ) : (
            <Empty className="min-h-80">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileText />
                </EmptyMedia>
                <EmptyTitle>
                  {showArchived
                    ? "Archive is empty"
                    : "Make room for shared context"}
                </EmptyTitle>
                <EmptyDescription>
                  {showArchived
                    ? "No archived documents."
                    : "Create a document to start sharing project context."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    </div>
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
  const [draft, setDraft] = useState("");
  const [baseContent, setBaseContent] = useState("");
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [remote, setRemote] = useState<RemoteRevision | null>(null);
  const [awaitingRemote, setAwaitingRemote] = useState(false);
  const [merging, setMerging] = useState(false);
  const [status, setStatus] = useState("Saved");
  const [rename, setRename] = useState(false);
  const [path, setPath] = useState("");
  const [editorError, setEditorError] = useState<string | null>(null);
  const editorRef = useRef<MDXEditorMethods>(null);
  const programmaticMarkdownRef = useRef<string | null>(null);
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
        editorError !== null ||
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
    [editorError, projectArchived, save]
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
      programmaticMarkdownRef.current = content;
      editorRef.current?.setMarkdown(content);
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
  const uploadImage = useCallback(
    (file: File) => uploadDocumentImage(api, documentId, file),
    [api, documentId]
  );
  const previewImage = useCallback(
    async (source: string) => {
      const attachmentId = documentImageAttachmentId(source);
      if (!attachmentId) return source;
      return (await api.downloadDocumentAttachment(documentId, attachmentId))
        .download_url;
    },
    [api, documentId]
  );
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
      className="flex min-h-0 min-w-0 flex-col bg-background"
      aria-labelledby="document-editor-heading"
    >
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
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
              className="truncate text-base font-semibold"
              title={current.document.path}
            >
              {current.document.path}
            </h2>
          )}
          <p
            role="status"
            aria-live="polite"
            className="mt-1 text-xs text-muted-foreground"
          >
            {status}
            {archived ? " · Archived" : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <DocumentHistory
            api={api}
            documentId={documentId}
            path={current.document.path}
            currentRevision={current.revision}
            hasUnsavedChanges={dirty}
          />
          {!archived ? (
            <Button
              size="sm"
              onClick={() => saveNow()}
              disabled={!dirty || save.isPending || Boolean(remote) || merging}
            >
              {save.isPending ? "Saving…" : "Save now"}
            </Button>
          ) : null}
          {!archived || !projectArchived ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Document actions"
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                {!archived ? (
                  <>
                    <DropdownMenuItem onSelect={() => setRename(true)}>
                      <Pencil aria-hidden="true" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        void api
                          .archiveDocument(documentId)
                          .then(invalidateDocument)
                      }
                    >
                      <Archive aria-hidden="true" />
                      Archive
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem
                    onSelect={() =>
                      void api
                        .restoreDocument(documentId)
                        .then(invalidateDocument)
                    }
                  >
                    <RotateCcw aria-hidden="true" />
                    Restore
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      {remote ? (
        <div
          className="m-5 shrink-0 rounded-lg border border-warning/50 p-3"
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
                programmaticMarkdownRef.current = remote.content;
                editorRef.current?.setMarkdown(remote.content);
                setEditorError(null);
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
      <section
        className="document-editor-surface flex min-h-0 flex-1 flex-col"
        aria-label="Markdown editor"
      >
        <label htmlFor="document-content" className="sr-only">
          Markdown content
        </label>
        <div className="flex min-h-0 flex-1 flex-col">
          {baseRevision === null ? (
            <p className="p-4 text-sm text-muted-foreground">Loading editor…</p>
          ) : (
            <MarkdownEditor
              ref={editorRef}
              markdown={draft}
              readOnly={archived}
              onChange={(markdown, initialMarkdownNormalize) => {
                if (programmaticMarkdownRef.current !== null) {
                  programmaticMarkdownRef.current = null;
                  return;
                }
                if (initialMarkdownNormalize) return;
                setEditorError(null);
                draftRef.current = markdown;
                setDraft(markdown);
                if (!remote && !merging) setStatus("Unsaved");
              }}
              onError={({ error, source }) => {
                draftRef.current = source;
                setDraft(source);
                setEditorError(error);
                setStatus(
                  "Markdown could not be rendered. Your source is preserved; fix it in Source mode."
                );
              }}
              imageUploadHandler={uploadImage}
              imagePreviewHandler={previewImage}
            />
          )}
        </div>
      </section>
      {editorError ? (
        <p role="alert" className="shrink-0 px-5 py-3 text-sm text-destructive">
          Markdown could not be rendered. Switch to Source mode to recover it.
        </p>
      ) : null}
      {merging && !remote && !archived ? (
        <div className="flex shrink-0 items-center gap-2 px-5 py-3">
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
    </section>
  );
}

export function attachmentProgress(loaded: number, total: number) {
  return total > 0 ? Math.max(0, Math.min(1, loaded / total)) : 0;
}

export function documentImageAttachmentId(source: string) {
  if (!source.startsWith(DOCUMENT_IMAGE_PREFIX)) return null;
  return source.slice(DOCUMENT_IMAGE_PREFIX.length) || null;
}

export async function uploadDocumentImage(
  api: Parameters<typeof documentsQueryOptions>[0],
  documentId: string,
  file: File
) {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type))
    throw new Error("Choose a PNG, JPEG, GIF, WebP, or AVIF image.");
  if (file.size > MAX_IMAGE_BYTES)
    throw new Error("Images are limited to 2 GiB.");

  const session = (
    await api.startDocumentAttachmentUpload(documentId, {
      filename: file.name,
      content_type: file.type,
      size_bytes: file.size
    })
  ).upload;
  const controller = new AbortController();

  try {
    const result =
      session.mode === "single"
        ? await (async () => {
            if (!session.upload_url)
              throw new Error("Upload session is missing its upload URL.");
            await api.putPresignedObject(
              session.upload_url,
              file,
              undefined,
              controller.signal
            );
            return api.completeDocumentAttachmentUpload(documentId, session.id);
          })()
        : await uploadMultipart(
            api,
            documentId,
            session,
            file,
            () => undefined,
            controller.signal,
            async () => undefined
          );
    return `${DOCUMENT_IMAGE_PREFIX}${result.attachment.id}`;
  } catch (error) {
    await api
      .abortDocumentAttachmentUpload(documentId, session.id)
      .catch(() => undefined);
    throw error;
  }
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
  return api.completeDocumentAttachmentUpload(documentId, session.id);
}
function DocumentMessage({
  title,
  message
}: {
  title: string;
  message: string;
}) {
  return (
    <PageState
      title={title}
      message={message}
      error={title.includes("unavailable")}
    />
  );
}
