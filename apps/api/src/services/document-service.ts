import { createHash, randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import {
  documentFolders,
  documentRevisions,
  documents,
  projects,
  type Database
} from "@orchestrat/db";
import {
  documentContentSchema,
  type CreateDocumentFolderRequest,
  type CreateDocumentRequest,
  type DocumentHistoryQuery,
  type DocumentListQuery,
  type EditDocumentRequest,
  type RenameDocumentRequest,
  type UpdateDocumentRequest
} from "@orchestrat/protocol";
import { and, asc, desc, eq, gt, isNull, lt, ne, or } from "drizzle-orm";
import { insertProjectEvent } from "./agent-service.js";
import type { AgentPrincipal } from "./agent-service.js";
import { ApiError } from "./api-error.js";
import {
  assertEntityBranch,
  resolveBranch,
  type BranchSelector
} from "./branch-context.js";
import { PermissionService } from "./permission-service.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Transaction;
export type DocumentStorageConfig = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  client?: S3Client;
};
type StoredContent = { content: string; size: number; sha256: string };
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const cursorError = () =>
  new ApiError(400, "VALIDATION_ERROR", "The cursor is invalid.");
const isUniqueViolation = (error: unknown) => {
  const value = error as { code?: string; message?: string };
  return (
    value.code === "23505" ||
    value.message?.includes("_branch_path_unique") === true
  );
};
const duplicateDocumentPath = () =>
  new ApiError(409, "CONFLICT", "A document already uses that path.");
const duplicateFolderPath = () =>
  new ApiError(409, "CONFLICT", "A folder already uses that path.");
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeDocumentCursor = (value: string) => {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as { updatedAt?: unknown; id?: unknown };
    if (
      typeof parsed.updatedAt !== "string" ||
      Number.isNaN(Date.parse(parsed.updatedAt)) ||
      typeof parsed.id !== "string" ||
      !uuidPattern.test(parsed.id)
    )
      throw cursorError();
    return { updatedAt: new Date(parsed.updatedAt), id: parsed.id };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw cursorError();
  }
};
const decodeRevisionCursor = (value: string) => {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as { revision?: unknown };
    if (
      typeof parsed.revision !== "number" ||
      !Number.isInteger(parsed.revision) ||
      parsed.revision < 1
    )
      throw cursorError();
    return parsed.revision;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw cursorError();
  }
};
const author = (type: "human" | "agent", id: string) => ({ type, id });
const documentJson = (value: typeof documents.$inferSelect) => ({
  id: value.id,
  project_id: value.projectId,
  branch_id: value.branchId,
  path: value.path,
  current_revision: value.currentRevision,
  archived_at: value.archivedAt?.toISOString() ?? null,
  created_by:
    value.createdByType && (value.createdByUserId ?? value.createdByAgentId)
      ? author(
          value.createdByType,
          value.createdByUserId ?? value.createdByAgentId!
        )
      : null,
  created_at: value.createdAt.toISOString(),
  updated_at: value.updatedAt.toISOString()
});
const folderJson = (value: typeof documentFolders.$inferSelect) => ({
  id: value.id,
  project_id: value.projectId,
  branch_id: value.branchId,
  path: value.path,
  created_at: value.createdAt.toISOString()
});
const revisionSummaryJson = (value: typeof documentRevisions.$inferSelect) => ({
  id: value.id,
  document_id: value.documentId,
  revision_number: value.revisionNumber,
  content_size_bytes: value.contentSizeBytes,
  content_sha256: value.contentSha256,
  author: author(value.authorType, value.authorUserId ?? value.authorAgentId!),
  created_at: value.createdAt.toISOString()
});

export class DocumentService {
  private readonly permissions: PermissionService;
  private readonly storage: S3Client | null;
  constructor(
    private readonly db: Database,
    private readonly storageConfig?: DocumentStorageConfig
  ) {
    this.permissions = new PermissionService(db);
    this.storage =
      storageConfig?.client ??
      (storageConfig
        ? new S3Client({
            forcePathStyle: true,
            region: storageConfig.region,
            endpoint: storageConfig.endpoint,
            credentials: {
              accessKeyId: storageConfig.accessKeyId,
              secretAccessKey: storageConfig.secretAccessKey
            }
          })
        : null);
  }
  private async access(userId: string, projectId: string, write = false) {
    const record = await this.permissions.projectAccess(userId, projectId);
    if (write && record.project.status === "archived")
      throw new ApiError(
        409,
        "PROJECT_ARCHIVED",
        "Archived projects are read-only."
      );
    return record.project;
  }
  private async lockActiveProject(tx: Transaction, projectId: string) {
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      // ponytail: project-wide serialization is sufficient for private-alpha document write volume; document/advisory locks are the upgrade when per-project throughput matters.
      .for("update");
    if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    if (project.status === "archived")
      throw new ApiError(
        409,
        "PROJECT_ARCHIVED",
        "Archived projects are read-only."
      );
    return project;
  }
  private objectKey(projectId: string, documentId: string, revisionId: string) {
    return `document-revisions/v1/${projectId}/${documentId}/${revisionId}.md`;
  }
  private content(buffer: Buffer): StoredContent {
    return {
      content: buffer.toString("utf8"),
      size: buffer.byteLength,
      sha256: createHash("sha256").update(buffer).digest("hex")
    };
  }
  private async readBody(body: unknown): Promise<Buffer> {
    if (
      body &&
      typeof (body as { transformToByteArray?: unknown })
        .transformToByteArray === "function"
    )
      return Buffer.from(
        await (
          body as { transformToByteArray: () => Promise<Uint8Array> }
        ).transformToByteArray()
      );
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>)
      chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  private async readRevisionContent(
    revision: typeof documentRevisions.$inferSelect
  ): Promise<StoredContent> {
    const inline = this.content(Buffer.from(revision.contentMarkdown, "utf8"));
    if (revision.contentSizeBytes === null && revision.contentSha256 === null)
      return inline;
    if (!this.storage || !this.storageConfig)
      throw new ApiError(
        503,
        "DOCUMENT_CONTENT_UNAVAILABLE",
        "Document content is unavailable."
      );
    try {
      const response = await this.storage.send(
        new GetObjectCommand({
          Bucket: this.storageConfig.bucket,
          Key: this.objectKey(
            revision.projectId,
            revision.documentId,
            revision.id
          )
        })
      );
      const object = this.content(await this.readBody(response.Body));
      if (
        revision.contentSizeBytes !== object.size ||
        revision.contentSha256 !== object.sha256
      )
        throw new Error("object integrity mismatch");
      return object;
    } catch {
      throw new ApiError(
        503,
        "DOCUMENT_CONTENT_UNAVAILABLE",
        "Document content is unavailable."
      );
    }
  }
  private async uploadContent(
    projectId: string,
    documentId: string,
    revisionId: string,
    content: StoredContent
  ) {
    if (!this.storage || !this.storageConfig) return;
    try {
      await this.storage.send(
        new PutObjectCommand({
          Bucket: this.storageConfig.bucket,
          Key: this.objectKey(projectId, documentId, revisionId),
          Body: Buffer.from(content.content, "utf8"),
          ContentType: "text/markdown; charset=utf-8",
          ContentLength: content.size,
          Metadata: { sha256: content.sha256 }
        })
      );
    } catch {
      throw new ApiError(
        503,
        "STORAGE_UPLOAD_FAILED",
        "Storage could not upload the document revision."
      );
    }
  }
  private async deleteContent(
    projectId: string,
    documentId: string,
    revisionId: string
  ) {
    if (!this.storage || !this.storageConfig) return;
    try {
      await this.storage.send(
        new DeleteObjectCommand({
          Bucket: this.storageConfig.bucket,
          Key: this.objectKey(projectId, documentId, revisionId)
        })
      );
    } catch {
      /* GC handles ambiguous orphan failures. */
    }
  }
  async deleteProjectStorage(projectId: string) {
    if (!this.storage || !this.storageConfig) return;
    for (const prefix of [
      `document-revisions/v1/${projectId}/`,
      `document-attachments/v1/${projectId}/`
    ]) {
      let continuationToken: string | undefined;
      do {
        let page;
        try {
          page = await this.storage.send(
            new ListObjectsV2Command({
              Bucket: this.storageConfig.bucket,
              Prefix: prefix,
              ContinuationToken: continuationToken
            })
          );
        } catch {
          break;
        }
        for (const object of page.Contents ?? []) {
          if (!object.Key) continue;
          await this.storage
            .send(
              new DeleteObjectCommand({
                Bucket: this.storageConfig.bucket,
                Key: object.Key
              })
            )
            .catch(() => undefined);
        }
        continuationToken = page.IsTruncated
          ? page.NextContinuationToken
          : undefined;
      } while (continuationToken);
    }
  }
  private async getProject(projectId: string, id: string) {
    const [document] = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.projectId, projectId)))
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    const [revision] = await this.db
      .select()
      .from(documentRevisions)
      .where(
        and(
          eq(documentRevisions.documentId, id),
          eq(documentRevisions.revisionNumber, document.currentRevision)
        )
      )
      .limit(1);
    if (!revision)
      throw new ApiError(
        503,
        "DOCUMENT_CONTENT_UNAVAILABLE",
        "Document revision is missing."
      );
    return {
      document: documentJson(document),
      revision: {
        ...revisionSummaryJson(revision),
        content: (await this.readRevisionContent(revision)).content
      }
    };
  }
  private async listProject(
    projectId: string,
    branchId: string,
    query: DocumentListQuery
  ) {
    const clauses = [
      eq(documents.projectId, projectId),
      eq(documents.branchId, branchId)
    ];
    if (!query.include_archived) clauses.push(isNull(documents.archivedAt));
    if (query.cursor) {
      const cursor = decodeDocumentCursor(query.cursor);
      clauses.push(
        or(
          gt(documents.updatedAt, cursor.updatedAt),
          and(
            eq(documents.updatedAt, cursor.updatedAt),
            gt(documents.id, cursor.id)
          )
        )!
      );
    }
    const rows = await this.db
      .select()
      .from(documents)
      .where(and(...clauses))
      .orderBy(asc(documents.updatedAt), asc(documents.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const folders = await this.db
      .select()
      .from(documentFolders)
      .where(
        and(
          eq(documentFolders.projectId, projectId),
          eq(documentFolders.branchId, branchId)
        )
      )
      .orderBy(asc(documentFolders.path));
    return {
      documents: page.map(documentJson),
      folders: folders.map(folderJson),
      next_cursor:
        rows.length > query.limit
          ? encode({
              updatedAt: page.at(-1)!.updatedAt.toISOString(),
              id: page.at(-1)!.id
            })
          : null
    };
  }
  async list(
    userId: string,
    projectId: string,
    query: DocumentListQuery,
    selector?: BranchSelector
  ) {
    await this.access(userId, projectId);
    const branch = await resolveBranch(this.db, projectId, selector);
    return this.listProject(projectId, branch.id, query);
  }
  async listForAgent(principal: AgentPrincipal, query: DocumentListQuery) {
    const branch = await resolveBranch(
      this.db,
      principal.projectId,
      principal.branch,
      { agentId: principal.agentId }
    );
    return this.listProject(principal.projectId, branch.id, query);
  }
  async createFolder(
    userId: string,
    projectId: string,
    input: CreateDocumentFolderRequest,
    selector?: BranchSelector
  ) {
    await this.access(userId, projectId, true);
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockActiveProject(tx, projectId);
        const branch = await resolveBranch(tx, projectId, selector, {
          write: true
        });
        const [folder] = await tx
          .insert(documentFolders)
          .values({ projectId, branchId: branch.id, path: input.path })
          .returning();
        return { folder: folderJson(folder!) };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateFolderPath();
      throw error;
    }
  }
  async get(userId: string, id: string) {
    const [document] = await this.db
      .select({ projectId: documents.projectId })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    await this.access(userId, document.projectId);
    return this.getProject(document.projectId, id);
  }
  async getForAgent(principal: AgentPrincipal, id: string) {
    return this.getProject(principal.projectId, id);
  }

  /**
   * Entity writes take the branch from the document (spec §6.1); an agent
   * that names or is pinned to another branch gets BRANCH_MISMATCH.
   */
  private branchGuard(
    tx: Executor,
    document: typeof documents.$inferSelect,
    authorType: "human" | "agent",
    authorId: string,
    selector: BranchSelector | undefined
  ) {
    return assertEntityBranch(
      tx,
      document.projectId,
      document.branchId,
      selector,
      {
        actor: authorType,
        write: true,
        agentId: authorType === "agent" ? authorId : undefined,
        notFound: "Document not found."
      }
    );
  }

  private async createProject(
    projectId: string,
    input: CreateDocumentRequest,
    authorType: "human" | "agent",
    authorId: string,
    selector: BranchSelector | undefined
  ) {
    const content = this.content(
      Buffer.from(documentContentSchema.parse(input.content), "utf8")
    );
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await this.uploadContent(projectId, documentId, revisionId, content);
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockActiveProject(tx, projectId);
        const branch = await resolveBranch(tx, projectId, selector, {
          write: true,
          agentId: authorType === "agent" ? authorId : undefined
        });
        const [pathConflict] = await tx
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.branchId, branch.id),
              eq(documents.path, input.path)
            )
          )
          .limit(1);
        if (pathConflict) throw duplicateDocumentPath();
        const [document] = await tx
          .insert(documents)
          .values({
            id: documentId,
            projectId,
            branchId: branch.id,
            path: input.path,
            createdByType: authorType,
            ...(authorType === "human"
              ? { createdByUserId: authorId }
              : { createdByAgentId: authorId })
          })
          .returning();
        const [revision] = await tx
          .insert(documentRevisions)
          .values({
            projectId,
            branchId: document!.branchId,
            documentId,
            id: revisionId,
            revisionNumber: 1,
            contentMarkdown: content.content,
            ...(this.storage
              ? {
                  contentSizeBytes: content.size,
                  contentSha256: content.sha256
                }
              : {}),
            authorType,
            ...(authorType === "human"
              ? { authorUserId: authorId }
              : { authorAgentId: authorId })
          })
          .returning();
        await insertProjectEvent(tx, {
          projectId,
          branchId: document.branchId,
          actorUserId: authorType === "human" ? authorId : null,
          actorAgentId: authorType === "agent" ? authorId : null,
          entityId: document.id,
          type: "document.created",
          payload: { path: document.path, revision: 1 }
        });
        return {
          document: documentJson(document),
          revision: {
            ...revisionSummaryJson(revision),
            content: content.content
          }
        };
      });
    } catch (error) {
      const [existing] = await this.db
        .select({ id: documentRevisions.id })
        .from(documentRevisions)
        .where(eq(documentRevisions.id, revisionId))
        .limit(1);
      if (!existing)
        await this.deleteContent(projectId, documentId, revisionId);
      if (isUniqueViolation(error)) throw duplicateDocumentPath();
      throw error;
    }
  }
  async create(
    userId: string,
    projectId: string,
    input: CreateDocumentRequest,
    selector?: BranchSelector
  ) {
    await this.access(userId, projectId, true);
    return this.createProject(projectId, input, "human", userId, selector);
  }
  async createForAgent(
    principal: AgentPrincipal,
    input: CreateDocumentRequest
  ) {
    return this.createProject(
      principal.projectId,
      input,
      "agent",
      principal.agentId,
      principal.branch
    );
  }
  private async current(projectId: string, id: string) {
    const [document] = await this.db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.projectId, projectId)))
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    const [revision] = await this.db
      .select()
      .from(documentRevisions)
      .where(
        and(
          eq(documentRevisions.documentId, id),
          eq(documentRevisions.revisionNumber, document.currentRevision)
        )
      )
      .limit(1);
    if (!revision)
      throw new ApiError(
        503,
        "DOCUMENT_CONTENT_UNAVAILABLE",
        "Document revision is missing."
      );
    return {
      document,
      revision,
      content: await this.readRevisionContent(revision)
    };
  }
  private async writeProject(
    projectId: string,
    id: string,
    input: UpdateDocumentRequest | EditDocumentRequest,
    authorType: "human" | "agent",
    authorId: string,
    selector?: BranchSelector
  ) {
    const base = await this.current(projectId, id);
    await this.branchGuard(
      this.db,
      base.document,
      authorType,
      authorId,
      selector
    );
    if (base.document.archivedAt)
      throw new ApiError(
        409,
        "DOCUMENT_ARCHIVED",
        "Archived documents are read-only."
      );
    const requestedContent =
      "content" in input ? documentContentSchema.parse(input.content) : null;
    // A full-content idempotent write is a no-op even when its base is stale.
    // Exact edits remain base-sensitive and are checked below before applying.
    if (requestedContent !== null && requestedContent === base.content.content)
      return {
        document: documentJson(base.document),
        revision: {
          ...revisionSummaryJson(base.revision),
          content: base.content.content
        }
      };
    if (base.document.currentRevision !== input.base_revision)
      throw new ApiError(
        409,
        "DOCUMENT_CONFLICT",
        "Document revision is stale.",
        {
          current_revision: base.document.currentRevision,
          base_revision: input.base_revision
        }
      );
    const content =
      "content" in input
        ? this.content(Buffer.from(requestedContent!, "utf8"))
        : this.applyEdits(base.content.content, input);
    if (content.content === base.content.content)
      return {
        document: documentJson(base.document),
        revision: {
          ...revisionSummaryJson(base.revision),
          content: base.content.content
        }
      };
    const revisionNumber = input.base_revision + 1;
    const revisionId = randomUUID();
    await this.uploadContent(projectId, id, revisionId, content);
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockActiveProject(tx, projectId);
        const [document] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.id, id), eq(documents.projectId, projectId)))
          .for("update");
        if (!document)
          throw new ApiError(404, "NOT_FOUND", "Document not found.");
        await this.branchGuard(tx, document, authorType, authorId, selector);
        if (document.archivedAt)
          throw new ApiError(
            409,
            "DOCUMENT_ARCHIVED",
            "Archived documents are read-only."
          );
        if (document.currentRevision !== input.base_revision)
          throw new ApiError(
            409,
            "DOCUMENT_CONFLICT",
            "Document revision is stale.",
            {
              current_revision: document.currentRevision,
              base_revision: input.base_revision
            }
          );
        const [updated] = await tx
          .update(documents)
          .set({ currentRevision: revisionNumber, updatedAt: new Date() })
          .where(
            and(
              eq(documents.id, id),
              eq(documents.currentRevision, input.base_revision)
            )
          )
          .returning();
        if (!updated) {
          const [current] = await tx
            .select({ currentRevision: documents.currentRevision })
            .from(documents)
            .where(eq(documents.id, id));
          throw new ApiError(
            409,
            "DOCUMENT_CONFLICT",
            "Document revision is stale.",
            {
              current_revision:
                current?.currentRevision ?? document.currentRevision,
              base_revision: input.base_revision
            }
          );
        }
        const [revision] = await tx
          .insert(documentRevisions)
          .values({
            projectId,
            branchId: document.branchId,
            documentId: id,
            id: revisionId,
            revisionNumber,
            contentMarkdown: content.content,
            ...(this.storage
              ? {
                  contentSizeBytes: content.size,
                  contentSha256: content.sha256
                }
              : {}),
            authorType,
            ...(authorType === "human"
              ? { authorUserId: authorId }
              : { authorAgentId: authorId })
          })
          .returning();
        await insertProjectEvent(tx, {
          projectId,
          branchId: document.branchId,
          actorUserId: authorType === "human" ? authorId : null,
          actorAgentId: authorType === "agent" ? authorId : null,
          entityId: id,
          type: "document.updated",
          payload: {
            path: updated.path,
            revision: revisionNumber,
            ...("content" in input && input.save_kind === "autosave"
              ? { save_kind: "autosave" }
              : {})
          }
        });
        return {
          document: documentJson(updated),
          revision: {
            ...revisionSummaryJson(revision),
            content: content.content
          }
        };
      });
    } catch (error) {
      const [existing] = await this.db
        .select({ id: documentRevisions.id })
        .from(documentRevisions)
        .where(and(eq(documentRevisions.id, revisionId)))
        .limit(1);
      if (!existing) await this.deleteContent(projectId, id, revisionId);
      if (isUniqueViolation(error)) throw duplicateDocumentPath();
      throw error;
    }
  }
  private applyEdits(
    content: string,
    input: EditDocumentRequest
  ): StoredContent {
    let next = content;
    input.edits.forEach((edit, index) => {
      let count = 0,
        offset = 0;
      while ((offset = next.indexOf(edit.old_text, offset)) !== -1) {
        count += 1;
        // Advance by one code unit so overlapping matches are counted too.
        offset += 1;
      }
      if (count !== 1)
        throw new ApiError(
          409,
          "DOCUMENT_EDIT_MISMATCH",
          "Document edit did not match exactly once.",
          { edit_index: index, match_count: count }
        );
      next = next.replace(edit.old_text, edit.new_text);
      if (!documentContentSchema.safeParse(next).success)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Document content exceeds the size limit."
        );
    });
    return this.content(Buffer.from(next, "utf8"));
  }
  async update(userId: string, id: string, input: UpdateDocumentRequest) {
    const [document] = await this.db
      .select({ projectId: documents.projectId })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    await this.access(userId, document.projectId, true);
    return this.writeProject(document.projectId, id, input, "human", userId);
  }
  async updateForAgent(
    principal: AgentPrincipal,
    id: string,
    input: UpdateDocumentRequest
  ) {
    return this.writeProject(
      principal.projectId,
      id,
      input,
      "agent",
      principal.agentId,
      principal.branch
    );
  }
  async edit(userId: string, id: string, input: EditDocumentRequest) {
    const [document] = await this.db
      .select({ projectId: documents.projectId })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    await this.access(userId, document.projectId, true);
    return this.writeProject(document.projectId, id, input, "human", userId);
  }
  async editForAgent(
    principal: AgentPrincipal,
    id: string,
    input: EditDocumentRequest
  ) {
    return this.writeProject(
      principal.projectId,
      id,
      input,
      "agent",
      principal.agentId,
      principal.branch
    );
  }

  private async renameProject(
    projectId: string,
    id: string,
    input: RenameDocumentRequest,
    authorType: "human" | "agent",
    authorId: string,
    selector?: BranchSelector
  ) {
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockActiveProject(tx, projectId);
        const [document] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.id, id), eq(documents.projectId, projectId)))
          .for("update");
        if (!document)
          throw new ApiError(404, "NOT_FOUND", "Document not found.");
        await this.branchGuard(tx, document, authorType, authorId, selector);
        if (document.archivedAt)
          throw new ApiError(
            409,
            "DOCUMENT_ARCHIVED",
            "Archived documents are read-only."
          );
        if (document.currentRevision !== input.expected_revision)
          throw new ApiError(
            409,
            "DOCUMENT_CONFLICT",
            "Document revision is stale.",
            {
              current_revision: document.currentRevision,
              base_revision: input.expected_revision
            }
          );
        if (document.path === input.path)
          return { document: documentJson(document) };
        const [pathConflict] = await tx
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(
              eq(documents.branchId, document.branchId),
              eq(documents.path, input.path),
              // The current document may retain its path through the no-op path
              // above, but never collide with another reserved document path.
              ne(documents.id, id)
            )
          )
          .limit(1);
        if (pathConflict) throw duplicateDocumentPath();
        const [updated] = await tx
          .update(documents)
          .set({ path: input.path, updatedAt: new Date() })
          .where(eq(documents.id, id))
          .returning();
        await insertProjectEvent(tx, {
          projectId,
          branchId: document.branchId,
          actorUserId: authorType === "human" ? authorId : null,
          actorAgentId: authorType === "agent" ? authorId : null,
          entityId: id,
          type: "document.renamed",
          payload: {
            old_path: document.path,
            path: updated.path,
            revision: updated.currentRevision
          }
        });
        return { document: documentJson(updated) };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateDocumentPath();
      throw error;
    }
  }
  async rename(userId: string, id: string, input: RenameDocumentRequest) {
    const [document] = await this.db
      .select({ projectId: documents.projectId })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    await this.access(userId, document.projectId, true);
    return this.renameProject(document.projectId, id, input, "human", userId);
  }
  async renameForAgent(
    principal: AgentPrincipal,
    id: string,
    input: RenameDocumentRequest
  ) {
    return this.renameProject(
      principal.projectId,
      id,
      input,
      "agent",
      principal.agentId,
      principal.branch
    );
  }
  private async archiveProject(
    projectId: string,
    id: string,
    authorType: "human" | "agent",
    authorId: string,
    restore: boolean,
    selector?: BranchSelector
  ) {
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, projectId);
      const [document] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), eq(documents.projectId, projectId)))
        .for("update");
      if (!document)
        throw new ApiError(404, "NOT_FOUND", "Document not found.");
      await this.branchGuard(tx, document, authorType, authorId, selector);
      if (restore ? !document.archivedAt : Boolean(document.archivedAt))
        return { document: documentJson(document) };
      const [updated] = await tx
        .update(documents)
        .set({ archivedAt: restore ? null : new Date(), updatedAt: new Date() })
        .where(eq(documents.id, id))
        .returning();
      await insertProjectEvent(tx, {
        projectId,
        branchId: document.branchId,
        actorUserId: authorType === "human" ? authorId : null,
        actorAgentId: authorType === "agent" ? authorId : null,
        entityId: id,
        type: restore ? "document.restored" : "document.archived",
        payload: { path: updated.path, revision: updated.currentRevision }
      });
      return { document: documentJson(updated) };
    });
  }
  async archive(userId: string, id: string) {
    const [document] = await this.db
      .select({ projectId: documents.projectId })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    await this.access(userId, document.projectId, true);
    return this.archiveProject(document.projectId, id, "human", userId, false);
  }
  async archiveForAgent(principal: AgentPrincipal, id: string) {
    return this.archiveProject(
      principal.projectId,
      id,
      "agent",
      principal.agentId,
      false,
      principal.branch
    );
  }
  async restore(userId: string, id: string) {
    const [document] = await this.db
      .select({ projectId: documents.projectId })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    await this.access(userId, document.projectId, true);
    return this.archiveProject(document.projectId, id, "human", userId, true);
  }
  async restoreForAgent(principal: AgentPrincipal, id: string) {
    return this.archiveProject(
      principal.projectId,
      id,
      "agent",
      principal.agentId,
      true,
      principal.branch
    );
  }

  private async revisionsProject(
    projectId: string,
    id: string,
    query: DocumentHistoryQuery
  ) {
    const [document] = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.projectId, projectId)))
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    const clauses = [eq(documentRevisions.documentId, id)];
    if (query.cursor)
      clauses.push(
        lt(documentRevisions.revisionNumber, decodeRevisionCursor(query.cursor))
      );
    const rows = await this.db
      .select()
      .from(documentRevisions)
      .where(and(...clauses))
      .orderBy(desc(documentRevisions.revisionNumber))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const revisions =
      query.view === "summary"
        ? page.map(revisionSummaryJson)
        : await Promise.all(
            page.map(async (revision) => ({
              ...revisionSummaryJson(revision),
              content: (await this.readRevisionContent(revision)).content
            }))
          );
    return {
      revisions,
      next_cursor:
        rows.length > query.limit
          ? encode({ revision: page.at(-1)!.revisionNumber })
          : null
    };
  }
  async revisions(userId: string, id: string, query: DocumentHistoryQuery) {
    const [document] = await this.db
      .select({ projectId: documents.projectId })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    await this.access(userId, document.projectId);
    return this.revisionsProject(document.projectId, id, query);
  }
  async revisionsForAgent(
    principal: AgentPrincipal,
    id: string,
    query: DocumentHistoryQuery
  ) {
    return this.revisionsProject(principal.projectId, id, query);
  }
  private async revisionProject(
    projectId: string,
    id: string,
    revisionNumber: number
  ) {
    const [revision] = await this.db
      .select()
      .from(documentRevisions)
      .where(
        and(
          eq(documentRevisions.projectId, projectId),
          eq(documentRevisions.documentId, id),
          eq(documentRevisions.revisionNumber, revisionNumber)
        )
      )
      .limit(1);
    if (!revision) throw new ApiError(404, "NOT_FOUND", "Revision not found.");
    return {
      revision: {
        ...revisionSummaryJson(revision),
        content: (await this.readRevisionContent(revision)).content
      }
    };
  }
  async revision(userId: string, id: string, revisionNumber: number) {
    const [document] = await this.db
      .select({ projectId: documents.projectId })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    await this.access(userId, document.projectId);
    return this.revisionProject(document.projectId, id, revisionNumber);
  }
  async revisionForAgent(
    principal: AgentPrincipal,
    id: string,
    revisionNumber: number
  ) {
    return this.revisionProject(principal.projectId, id, revisionNumber);
  }
}
