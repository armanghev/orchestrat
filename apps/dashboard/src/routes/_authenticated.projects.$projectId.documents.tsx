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
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

function buildDocumentTree(
  documents: ProjectDocument[],
  folderPaths: string[]
) {
  const root: DocumentTreeNode[] = [];
  const folderChildren = (path: string) => {
    let children = root;
    let folderPath = "";

    for (const part of path.split("/").filter(Boolean)) {
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
    return children;
  };

  for (const path of folderPaths) folderChildren(path);

  for (const document of documents) {
    const parts = document.path.split("/");
    const name = parts.pop() ?? document.path;
    const children = folderChildren(parts.join("/"));

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

function markdownPath(value: string) {
  const path = value.trim();
  const name = path.split("/").at(-1) ?? "";
  if (!name) return null;
  if (name.toLowerCase().endsWith(".md")) return path;
  return name.includes(".") ? null : `${path}.md`;
}

function InlineDocumentName({
  label,
  initialValue = "",
  pending,
  error,
  onSubmit,
  onCancel
}: {
  label: string;
  initialValue?: string;
  pending: boolean;
  error?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const extension = input.value.toLowerCase().endsWith(".md") ? 3 : 0;
    input.setSelectionRange(0, input.value.length - extension);
  }, [error, invalid]);
  const commit = () => {
    if (pending) return;
    if (!value.trim()) return onCancel();
    const name = markdownPath(value);
    if (!name || name.includes("/")) return setInvalid(true);
    onSubmit(name);
  };

  return (
    <div className="px-1 py-0.5">
      <div className="flex items-center gap-1.5">
        <FileText
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          ref={inputRef}
          autoFocus
          aria-label={label}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          disabled={pending}
          className="h-7 min-w-0 px-1.5 text-sm"
        />
      </div>
      {invalid || error ? (
        <p role="alert" className="mt-1 pl-5 text-xs text-destructive">
          {error ?? "Use a Markdown filename ending in .md."}
        </p>
      ) : null}
    </div>
  );
}

function DocumentTree({
  documents,
  folderPaths,
  selectedId,
  onSelect,
  newFileParent,
  renamingId,
  pending,
  error,
  onCreateDocument,
  onCreateFile,
  onStartRename,
  onRename,
  onCancelEdit
}: {
  documents: ProjectDocument[];
  folderPaths: string[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  newFileParent: string | null;
  renamingId: string | null;
  pending: boolean;
  error?: string;
  onCreateDocument?: (folderPath: string) => void;
  onCreateFile: (folderPath: string, name: string) => void;
  onStartRename?: (document: ProjectDocument) => void;
  onRename: (document: ProjectDocument, name: string) => void;
  onCancelEdit: () => void;
}) {
  return (
    <ul className="space-y-0.5">
      {newFileParent === "" ? (
        <li>
          <InlineDocumentName
            label="New document name"
            pending={pending}
            error={error}
            onSubmit={(name) => onCreateFile("", name)}
            onCancel={onCancelEdit}
          />
        </li>
      ) : null}
      {buildDocumentTree(documents, folderPaths).map((node) => (
        <DocumentTreeItem
          key={node.type === "folder" ? node.path : node.document.id}
          node={node}
          selectedId={selectedId}
          onSelect={onSelect}
          newFileParent={newFileParent}
          renamingId={renamingId}
          pending={pending}
          error={error}
          onCreateDocument={onCreateDocument}
          onCreateFile={onCreateFile}
          onStartRename={onStartRename}
          onRename={onRename}
          onCancelEdit={onCancelEdit}
        />
      ))}
    </ul>
  );
}

function DocumentTreeItem({
  node,
  selectedId,
  onSelect,
  newFileParent,
  renamingId,
  pending,
  error,
  onCreateDocument,
  onCreateFile,
  onStartRename,
  onRename,
  onCancelEdit
}: {
  node: DocumentTreeNode;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  newFileParent: string | null;
  renamingId: string | null;
  pending: boolean;
  error?: string;
  onCreateDocument?: (folderPath: string) => void;
  onCreateFile: (folderPath: string, name: string) => void;
  onStartRename?: (document: ProjectDocument) => void;
  onRename: (document: ProjectDocument, name: string) => void;
  onCancelEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containsNewFile =
    node.type === "folder" &&
    newFileParent !== null &&
    (newFileParent === node.path || newFileParent.startsWith(`${node.path}/`));
  useEffect(() => {
    if (containsNewFile) setOpen(true);
  }, [containsNewFile]);

  if (node.type === "folder") {
    return (
      <li>
        <div className="group flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted"
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
          {onCreateDocument ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground opacity-70 hover:opacity-100"
              onClick={() => onCreateDocument(node.path)}
              aria-label={`Create document in ${node.path}`}
              title={`Create document in ${node.path}`}
            >
              <Plus aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        {open ? (
          <ul className="ml-3 space-y-0.5 border-l border-border/70 pl-1">
            {node.children.map((child) => (
              <DocumentTreeItem
                key={child.type === "folder" ? child.path : child.document.id}
                node={child}
                selectedId={selectedId}
                onSelect={onSelect}
                newFileParent={newFileParent}
                renamingId={renamingId}
                pending={pending}
                error={error}
                onCreateDocument={onCreateDocument}
                onCreateFile={onCreateFile}
                onStartRename={onStartRename}
                onRename={onRename}
                onCancelEdit={onCancelEdit}
              />
            ))}
            {newFileParent === node.path ? (
              <li>
                <InlineDocumentName
                  label={`New document name in ${node.path}`}
                  pending={pending}
                  error={error}
                  onSubmit={(name) => onCreateFile(node.path, name)}
                  onCancel={onCancelEdit}
                />
              </li>
            ) : null}
          </ul>
        ) : null}
      </li>
    );
  }

  const selected = selectedId === node.document.id;
  if (renamingId === node.document.id) {
    return (
      <li>
        <InlineDocumentName
          label={`Rename ${node.document.path}`}
          initialValue={node.name}
          pending={pending}
          error={error}
          onSubmit={(name) => onRename(node.document, name)}
          onCancel={onCancelEdit}
        />
      </li>
    );
  }
  return (
    <li>
      <div className="group flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => onSelect(node.document.id)}
          onDoubleClick={() => onStartRename?.(node.document)}
          onKeyDown={(event) => {
            if (event.key === "F2") onStartRename?.(node.document);
          }}
          className={cn(
            "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted",
            selected
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground"
          )}
          aria-current={selected ? "page" : undefined}
          title={node.document.path}
        >
          <FileText className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium">
            {node.name}
          </span>
        </button>
        {onStartRename ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
            onClick={() => onStartRename(node.document)}
            aria-label={`Rename ${node.document.path}`}
            title="Rename"
          >
            <Pencil aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function DocumentsRoute() {
  const { projectId } = Route.useParams();
  const { api, project } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [newFileParent, setNewFileParent] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [newFolderPath, setNewFolderPath] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const documents = useQuery(documentsQueryOptions(api, projectId));
  const create = useMutation({
    mutationFn: (path: string) =>
      api.createDocument(projectId, { path, content: "" }),
    onSuccess: async (result) => {
      setNewFileParent(null);
      setSelectedId(result.document.id);
      await queryClient.invalidateQueries({
        queryKey: coordinationKeys.documents(projectId)
      });
    }
  });
  const createFolder = useMutation({
    mutationFn: (path: string) => api.createDocumentFolder(projectId, { path }),
    onSuccess: async () => {
      setNewFolderPath("");
      setCreatingFolder(false);
      await queryClient.invalidateQueries({
        queryKey: coordinationKeys.documents(projectId)
      });
    }
  });
  const renameDocument = useMutation({
    mutationFn: (input: {
      documentId: string;
      path: string;
      expectedRevision: number;
    }) =>
      api.renameDocument(input.documentId, {
        path: input.path,
        expected_revision: input.expectedRevision
      }),
    onSuccess: async (_, input) => {
      setRenamingId(null);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: coordinationKeys.documents(projectId)
        }),
        queryClient.invalidateQueries({
          queryKey: coordinationKeys.document(input.documentId)
        })
      ]);
    }
  });
  const startCreatingDocument = (folderPath: string) => {
    create.reset();
    renameDocument.reset();
    setCreatingFolder(false);
    setRenamingId(null);
    setNewFileParent(folderPath);
  };
  const startRenaming = (document: ProjectDocument) => {
    create.reset();
    renameDocument.reset();
    setNewFileParent(null);
    setSelectedId(document.id);
    setRenamingId(document.id);
  };

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
  const treeError = create.error ?? renameDocument.error;
  const treeErrorMessage =
    treeError instanceof Error ? treeError.message : undefined;
  return (
    <div
      className="document-workspace dashboard-page min-h-full"
      aria-label="Project documents"
    >
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
              onValueChange={(value) => {
                setShowArchived(value === "archived");
                setCreatingFolder(false);
                setNewFileParent(null);
                setRenamingId(null);
              }}
              className="gap-0"
            >
              <div className="space-y-2 border-b p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">Documents</span>
                  {!projectArchived && !showArchived ? (
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => startCreatingDocument("")}
                        aria-label="Create document"
                        title="Create document"
                      >
                        <FilePlus aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => {
                          createFolder.reset();
                          setNewFileParent(null);
                          setRenamingId(null);
                          setNewFolderPath("");
                          setCreatingFolder(true);
                        }}
                        aria-label="Create folder"
                        title="Create folder"
                      >
                        <FolderPlus aria-hidden="true" />
                      </Button>
                    </div>
                  ) : null}
                </div>
                <TabsList className="w-full" aria-label="Document state">
                  <TabsTrigger value="active">
                    Active ({active.length})
                  </TabsTrigger>
                  <TabsTrigger value="archived">
                    Archived ({archived.length})
                  </TabsTrigger>
                </TabsList>
                {creatingFolder ? (
                  <form
                    className="space-y-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (newFolderPath.trim())
                        createFolder.mutate(newFolderPath.trim());
                    }}
                  >
                    <Input
                      autoFocus
                      aria-label="New folder path"
                      value={newFolderPath}
                      onChange={(event) => setNewFolderPath(event.target.value)}
                      placeholder="notes"
                      disabled={createFolder.isPending}
                      className="h-8"
                    />
                    {createFolder.error ? (
                      <p role="alert" className="text-xs text-destructive">
                        {createFolder.error instanceof Error
                          ? createFolder.error.message
                          : "Unable to create the folder."}
                      </p>
                    ) : null}
                    <div className="flex gap-1.5">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={
                          createFolder.isPending || !newFolderPath.trim()
                        }
                      >
                        {createFolder.isPending ? "Creating…" : "Create"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setCreatingFolder(false)}
                        disabled={createFolder.isPending}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : null}
              </div>
              <TabsContent value={showArchived ? "archived" : "active"}>
                <div className="max-h-40 flex flex-col gap-1 overflow-y-auto p-2 md:max-h-[70dvh]">
                  <DocumentTree
                    documents={visible}
                    folderPaths={
                      showArchived
                        ? []
                        : documents.data.folders.map((folder) => folder.path)
                    }
                    selectedId={selected?.id}
                    onSelect={setSelectedId}
                    newFileParent={newFileParent}
                    renamingId={renamingId}
                    pending={create.isPending || renameDocument.isPending}
                    error={treeErrorMessage}
                    onCreateDocument={
                      !showArchived && !projectArchived
                        ? startCreatingDocument
                        : undefined
                    }
                    onCreateFile={(folderPath, name) =>
                      create.mutate(folderPath ? `${folderPath}/${name}` : name)
                    }
                    onStartRename={
                      !showArchived && !projectArchived
                        ? startRenaming
                        : undefined
                    }
                    onRename={(document, name) => {
                      const slash = document.path.lastIndexOf("/");
                      renameDocument.mutate({
                        documentId: document.id,
                        path:
                          slash < 0
                            ? name
                            : `${document.path.slice(0, slash + 1)}${name}`,
                        expectedRevision: document.current_revision
                      });
                    }}
                    onCancelEdit={() => {
                      setNewFileParent(null);
                      setRenamingId(null);
                    }}
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
  const [autosaveRetry, setAutosaveRetry] = useState(0);
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
    onSuccess: async (result) => {
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
      } else {
        awaitingRemoteRef.current = false;
        setAwaitingRemote(false);
        remoteRef.current = null;
        setRemote(null);
        setMerging(false);
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
        setAutosaveRetry((attempt) => attempt + 1);
      }
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
      return;
    }
    if (revision <= baseRevisionRef.current) return;
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
      return;
    }
    const target = {
      revision,
      content,
      actor: `${next.revision.author.type} ${next.revision.author.id}`
    };
    remoteRef.current = target;
    awaitingRemoteRef.current = false;
    setAwaitingRemote(false);
    setRemote(target);
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
    autosaveRetry,
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
        <div className="min-w-0 flex-1">
          {rename && !archived ? (
            <div className="flex items-center gap-2">
              <Input
                aria-label="Document path"
                className="min-w-0 flex-1"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
              <Button
                size="sm"
                className="shrink-0"
                onClick={() => void renameDocument()}
              >
                Rename
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0"
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
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <DocumentHistory
            api={api}
            projectId={projectId}
            documentId={documentId}
            path={current.document.path}
            currentRevision={current.revision}
            hasUnsavedChanges={dirty}
            readOnly={archived}
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
              }}
              onError={({ error, source }) => {
                draftRef.current = source;
                setDraft(source);
                setEditorError(error);
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
