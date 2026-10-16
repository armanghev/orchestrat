import { randomUUID } from "node:crypto";
import {
  documentAttachments,
  documentFolders,
  documentRevisions,
  documents,
  type Database
} from "@orchestrat/db";
import { and, asc, eq } from "drizzle-orm";
import type { Baseline, Executor } from "./baselines.js";
import {
  changedFields,
  fingerprintOf,
  sameFingerprint,
  type Fingerprint
} from "./fingerprint.js";
import { lineageOf } from "./task-items.js";

// Documents, their revisions and attachments, and folders in the merge engine.
// A document matches by lineage, else by path; deletions never propagate.

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DocumentRow = typeof documents.$inferSelect;
export type RevisionRow = typeof documentRevisions.$inferSelect;
export type AttachmentRow = typeof documentAttachments.$inferSelect;
type FolderRow = typeof documentFolders.$inferSelect;

export type DocumentSide = {
  documents: DocumentRow[];
  byId: Map<string, DocumentRow>;
  byLineage: Map<string, DocumentRow>;
  byPath: Map<string, DocumentRow>;
  /** The current revision per document id. */
  current: Map<string, RevisionRow>;
  /** Attachments per document id. */
  attachments: Map<string, AttachmentRow[]>;
  /** Attachment id → lineage key, for normalizing body references. */
  attachmentLineage: Map<string, string>;
  folders: FolderRow[];
};

export async function loadDocumentSide(
  db: Executor,
  branchId: string
): Promise<DocumentSide> {
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.branchId, branchId))
    .orderBy(asc(documents.path));
  const revisions = await db
    .select({ revision: documentRevisions })
    .from(documentRevisions)
    .innerJoin(
      documents,
      and(
        eq(documents.id, documentRevisions.documentId),
        eq(documents.currentRevision, documentRevisions.revisionNumber)
      )
    )
    .where(eq(documents.branchId, branchId));
  const attachmentRows = await db
    .select()
    .from(documentAttachments)
    .where(eq(documentAttachments.branchId, branchId))
    .orderBy(asc(documentAttachments.createdAt), asc(documentAttachments.id));
  const folders = await db
    .select()
    .from(documentFolders)
    .where(eq(documentFolders.branchId, branchId))
    .orderBy(asc(documentFolders.path));
  const attachments = new Map<string, AttachmentRow[]>();
  for (const attachment of attachmentRows)
    attachments.set(attachment.documentId, [
      ...(attachments.get(attachment.documentId) ?? []),
      attachment
    ]);
  return {
    documents: rows,
    byId: new Map(rows.map((row) => [row.id, row])),
    byLineage: new Map(rows.map((row) => [lineageOf(row), row])),
    byPath: new Map(rows.map((row) => [row.path, row])),
    current: new Map(
      revisions.map(({ revision }) => [revision.documentId, revision])
    ),
    attachments,
    attachmentLineage: new Map(
      attachmentRows.map((row) => [row.id, lineageOf(row)])
    ),
    folders
  };
}

const attachmentRef = /orchestrat-attachment:([0-9a-fA-F-]{36})/g;

/** Rewrites `orchestrat-attachment:<id>` references through `map`. */
export const rewriteRefs = (body: string, map: Map<string, string>) =>
  body.replace(
    attachmentRef,
    (match, id: string) =>
      `orchestrat-attachment:${map.get(id.toLowerCase()) ?? id}`
  );

/**
 * Compared fields. The body is hashed with attachment references normalized
 * to lineage keys, because copying gives attachments new ids.
 */
export const documentValues = (side: DocumentSide, document: DocumentRow) => ({
  path: document.path,
  body: rewriteRefs(
    side.current.get(document.id)?.contentMarkdown ?? "",
    side.attachmentLineage
  ),
  archived: document.archivedAt !== null
});

export type DocumentPlanItem = {
  lineage: string;
  /** The item's baseline key: its lineage on the lower branch id's side. */
  baselineKey: string;
  source: DocumentRow;
  target: DocumentRow | null;
  outcome:
    "copy" | "apply" | "unchanged" | "keep_target" | "conflict" | "skipped";
  reason: "changed_on_both" | "added_on_both" | "path_collision" | null;
  fields: string[];
  sourceFingerprint: Fingerprint;
  targetFingerprint: Fingerprint | null;
  /** Source attachments the target lacks, by lineage. */
  attachments: AttachmentRow[];
};

export function planDocuments(input: {
  kind: "import" | "merge";
  selection: "all" | string[];
  source: DocumentSide;
  target: DocumentSide;
  baselines: Map<string, Baseline>;
  sourceIsLow: boolean;
}): DocumentPlanItem[] {
  const { source, target } = input;
  const roots =
    input.selection === "all"
      ? source.documents
      : input.selection
          .map((lineage) => source.byLineage.get(lineage))
          .filter((row): row is DocumentRow => Boolean(row));
  const items: DocumentPlanItem[] = [];
  for (const document of roots) {
    const lineage = lineageOf(document);
    let match = target.byLineage.get(lineage) ?? null;
    let byPath = false;
    // A path match counts only for a document no other source item claims.
    const atPath = target.byPath.get(document.path);
    if (!match && atPath && !source.byLineage.has(lineageOf(atPath))) {
      match = atPath;
      byPath = true;
    }
    const s = fingerprintOf(documentValues(source, document));
    const base = {
      lineage,
      baselineKey: match && !input.sourceIsLow ? lineageOf(match) : lineage,
      source: document,
      target: match,
      sourceFingerprint: s
    };
    if (!match) {
      items.push({
        ...base,
        // The path belongs to another document both sides have.
        ...(atPath
          ? { outcome: "skipped", reason: "path_collision" }
          : { outcome: "copy", reason: null }),
        fields: [],
        targetFingerprint: null,
        attachments: atPath ? [] : (source.attachments.get(document.id) ?? [])
      });
      continue;
    }
    const t = fingerprintOf(documentValues(target, match));
    const b = input.baselines.get(base.baselineKey)?.fingerprint;
    const present = new Set(
      (target.attachments.get(match.id) ?? []).map(lineageOf)
    );
    const attachments = (source.attachments.get(document.id) ?? []).filter(
      (attachment) => !present.has(lineageOf(attachment))
    );
    const changedSource = changedFields(s, b);
    const changedTarget = changedFields(t, b);
    const outcome = (
      value: Pick<DocumentPlanItem, "outcome" | "reason" | "fields">
    ) => items.push({ ...base, ...value, targetFingerprint: t, attachments });
    // A rename onto a path another target document holds can never land.
    const taken = target.byPath.get(document.path);
    const collides =
      document.path !== match.path &&
      taken !== undefined &&
      taken.id !== match.id;
    if (sameFingerprint(s, t))
      outcome({ outcome: "unchanged", reason: null, fields: [] });
    else if (collides && (!b || changedSource.includes("path")))
      outcome(
        input.kind === "import"
          ? { outcome: "skipped", reason: "path_collision", fields: ["path"] }
          : { outcome: "conflict", reason: "path_collision", fields: ["path"] }
      );
    else if (!b && byPath)
      outcome({
        outcome: "conflict",
        reason: "added_on_both",
        fields: changedFields(s, t)
      });
    else if (b && changedTarget.length === 0)
      outcome({ outcome: "apply", reason: null, fields: changedSource });
    else if (b && changedSource.length === 0)
      outcome({ outcome: "keep_target", reason: null, fields: [] });
    else
      outcome({
        outcome: "conflict",
        reason: "changed_on_both",
        fields: changedFields(s, t)
      });
  }
  return items;
}

/** Folders are a union of paths; an import brings those its documents use. */
export function planFolders(
  input: {
    source: DocumentSide;
    target: DocumentSide;
    kind: "import" | "merge";
  },
  documentsLanding: DocumentRow[]
) {
  const present = new Set(input.target.folders.map((folder) => folder.path));
  return input.source.folders
    .filter((folder) => !present.has(folder.path))
    .filter(
      (folder) =>
        input.kind === "merge" ||
        documentsLanding.some((document) =>
          document.path.startsWith(`${folder.path}/`)
        )
    )
    .map((folder) => folder.path);
}

/** The new id an attachment gets in the target, and where its object goes. */
export type AttachmentCopy = {
  source: AttachmentRow;
  id: string;
  documentId: string;
};

/** Ids for every document and attachment the plan copies, made up front so
 * attachment objects can be copied before the transaction. */
export function allocate(items: DocumentPlanItem[]) {
  const documentIds = new Map<string, string>();
  const attachments: AttachmentCopy[] = [];
  for (const item of items) {
    if (item.outcome === "skipped") continue;
    const documentId = item.target?.id ?? randomUUID();
    if (!item.target) documentIds.set(item.source.id, documentId);
    for (const attachment of item.attachments)
      attachments.push({ source: attachment, id: randomUUID(), documentId });
  }
  return { documentIds, attachments };
}

export async function insertDocumentCopy(
  tx: Transaction,
  value: {
    source: DocumentRow;
    lineage: string;
    id: string;
    targetBranchId: string;
    attachments: AttachmentCopy[];
    /** Source attachment id → target attachment id, for body references. */
    refs: Map<string, string>;
    now: Date;
  }
) {
  const { source } = value;
  const [copy] = await tx
    .insert(documents)
    .values({
      id: value.id,
      projectId: source.projectId,
      branchId: value.targetBranchId,
      originId: value.lineage,
      path: source.path,
      currentRevision: source.currentRevision,
      archivedAt: source.archivedAt,
      createdByType: source.createdByType,
      createdByUserId: source.createdByUserId,
      createdByAgentId: source.createdByAgentId,
      createdAt: source.createdAt,
      updatedAt: value.now
    })
    .returning();
  // Every revision travels with a new copy, its content stored inline.
  const history = await tx
    .select()
    .from(documentRevisions)
    .where(eq(documentRevisions.documentId, source.id))
    .orderBy(asc(documentRevisions.revisionNumber));
  for (const revision of history)
    await tx.insert(documentRevisions).values({
      projectId: source.projectId,
      branchId: value.targetBranchId,
      documentId: value.id,
      originId: lineageOf(revision),
      revisionNumber: revision.revisionNumber,
      contentMarkdown: rewriteRefs(revision.contentMarkdown, value.refs),
      authorType: revision.authorType,
      authorUserId: revision.authorUserId,
      authorAgentId: revision.authorAgentId,
      createdAt: revision.createdAt
    });
  await insertAttachments(tx, value.targetBranchId, value.attachments);
  return copy!;
}

export async function insertAttachments(
  tx: Transaction,
  branchId: string,
  copies: AttachmentCopy[]
) {
  for (const copy of copies)
    await tx.insert(documentAttachments).values({
      id: copy.id,
      projectId: copy.source.projectId,
      branchId,
      documentId: copy.documentId,
      originId: lineageOf(copy.source),
      filename: copy.source.filename,
      mimeType: copy.source.mimeType,
      sizeBytes: copy.source.sizeBytes,
      addedByType: copy.source.addedByType,
      addedByUserId: copy.source.addedByUserId,
      addedByAgentId: copy.source.addedByAgentId,
      createdAt: copy.source.createdAt
    });
}

/**
 * Applies source fields to a target document. A body change appends one
 * revision authored by the source's current author; its time is now, so the
 * target's history stays in order.
 */
export async function applyDocumentValues(
  tx: Transaction,
  value: {
    target: DocumentRow;
    sourceRevision: RevisionRow;
    values: { path: string; archived: boolean };
    fields: string[];
    refs: Map<string, string>;
    now: Date;
  }
) {
  const { target, now } = value;
  const set: Partial<typeof documents.$inferInsert> = { updatedAt: now };
  if (value.fields.includes("body")) {
    set.currentRevision = target.currentRevision + 1;
    await tx.insert(documentRevisions).values({
      projectId: target.projectId,
      branchId: target.branchId,
      documentId: target.id,
      originId: lineageOf(value.sourceRevision),
      revisionNumber: target.currentRevision + 1,
      contentMarkdown: rewriteRefs(
        value.sourceRevision.contentMarkdown,
        value.refs
      ),
      authorType: value.sourceRevision.authorType,
      authorUserId: value.sourceRevision.authorUserId,
      authorAgentId: value.sourceRevision.authorAgentId,
      createdAt: now
    });
  }
  if (value.fields.includes("path")) set.path = value.values.path;
  if (value.fields.includes("archived"))
    set.archivedAt = value.values.archived ? (target.archivedAt ?? now) : null;
  const [updated] = await tx
    .update(documents)
    .set(set)
    .where(eq(documents.id, target.id))
    .returning();
  return updated!;
}

export async function insertFolders(
  tx: Transaction,
  value: { projectId: string; branchId: string; paths: string[] }
) {
  for (const path of value.paths)
    await tx
      .insert(documentFolders)
      .values({ projectId: value.projectId, branchId: value.branchId, path });
}
