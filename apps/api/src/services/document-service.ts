import {
  documentRevisions,
  documents,
  projects,
  type Database
} from "@orchestrat/db";
import type {
  CreateDocumentRequest,
  DocumentListQuery,
  UpdateDocumentRequest
} from "@orchestrat/protocol";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { insertProjectEvent } from "./agent-service.js";
import type { AgentPrincipal } from "./agent-service.js";
import { ApiError } from "./api-error.js";
import { PermissionService } from "./permission-service.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const cursorError = () =>
  new ApiError(400, "VALIDATION_ERROR", "The cursor is invalid.");
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decodeCursor = (value: string) => {
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

const author = (type: "human" | "agent", id: string) => ({ type, id });
const documentJson = (value: typeof documents.$inferSelect) => ({
  id: value.id,
  project_id: value.projectId,
  path: value.path,
  current_revision: value.currentRevision,
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
const revisionJson = (value: typeof documentRevisions.$inferSelect) => ({
  id: value.id,
  document_id: value.documentId,
  revision_number: value.revisionNumber,
  content: value.contentMarkdown,
  author: author(value.authorType, value.authorUserId ?? value.authorAgentId!),
  created_at: value.createdAt.toISOString()
});

export class DocumentService {
  private readonly permissions: PermissionService;

  constructor(private readonly db: Database) {
    this.permissions = new PermissionService(db);
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
        500,
        "INTERNAL_ERROR",
        "Document revision is missing."
      );
    return {
      document: documentJson(document),
      revision: revisionJson(revision)
    };
  }

  private async listProject(projectId: string, query: DocumentListQuery) {
    const clauses = [eq(documents.projectId, projectId)];
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
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
    return {
      documents: page.map(documentJson),
      next_cursor:
        rows.length > query.limit
          ? encode({
              updatedAt: page.at(-1)!.updatedAt.toISOString(),
              id: page.at(-1)!.id
            })
          : null
    };
  }

  async list(userId: string, projectId: string, query: DocumentListQuery) {
    await this.access(userId, projectId);
    return this.listProject(projectId, query);
  }

  async listForAgent(principal: AgentPrincipal, query: DocumentListQuery) {
    return this.listProject(principal.projectId, query);
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

  private async createProject(
    projectId: string,
    input: CreateDocumentRequest,
    authorType: "human" | "agent",
    authorId: string
  ) {
    return this.db.transaction(async (tx) => {
      await this.lockActiveProject(tx, projectId);
      const [document] = await tx
        .insert(documents)
        .values({
          projectId,
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
          documentId: document.id,
          revisionNumber: 1,
          contentMarkdown: input.content,
          authorType,
          ...(authorType === "human"
            ? { authorUserId: authorId }
            : { authorAgentId: authorId })
        })
        .returning();
      await insertProjectEvent(tx, {
        projectId,
        actorUserId: authorType === "human" ? authorId : null,
        actorAgentId: authorType === "agent" ? authorId : null,
        entityId: document.id,
        type: "document.created",
        payload: { path: document.path, revision: 1 }
      });
      return {
        document: documentJson(document),
        revision: revisionJson(revision)
      };
    });
  }

  async create(
    userId: string,
    projectId: string,
    input: CreateDocumentRequest
  ) {
    await this.access(userId, projectId, true);
    return this.createProject(projectId, input, "human", userId);
  }

  async createForAgent(
    principal: AgentPrincipal,
    input: CreateDocumentRequest
  ) {
    return this.createProject(
      principal.projectId,
      input,
      "agent",
      principal.agentId
    );
  }

  private async updateProject(
    projectId: string,
    id: string,
    input: UpdateDocumentRequest,
    authorType: "human" | "agent",
    authorId: string
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
      const revisionNumber = document.currentRevision + 1;
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
          documentId: id,
          revisionNumber,
          contentMarkdown: input.content,
          authorType,
          ...(authorType === "human"
            ? { authorUserId: authorId }
            : { authorAgentId: authorId })
        })
        .returning();
      await insertProjectEvent(tx, {
        projectId,
        actorUserId: authorType === "human" ? authorId : null,
        actorAgentId: authorType === "agent" ? authorId : null,
        entityId: id,
        type: "document.updated",
        payload: { path: updated.path, revision: revisionNumber }
      });
      return {
        document: documentJson(updated),
        revision: revisionJson(revision)
      };
    });
  }

  async update(userId: string, id: string, input: UpdateDocumentRequest) {
    const [document] = await this.db
      .select({ projectId: documents.projectId })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    await this.access(userId, document.projectId, true);
    return this.updateProject(document.projectId, id, input, "human", userId);
  }

  async updateForAgent(
    principal: AgentPrincipal,
    id: string,
    input: UpdateDocumentRequest
  ) {
    return this.updateProject(
      principal.projectId,
      id,
      input,
      "agent",
      principal.agentId
    );
  }

  private async revisionsProject(projectId: string, id: string) {
    const [document] = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.projectId, projectId)))
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    const rows = await this.db
      .select()
      .from(documentRevisions)
      .where(eq(documentRevisions.documentId, id))
      .orderBy(asc(documentRevisions.revisionNumber));
    return { revisions: rows.map(revisionJson), next_cursor: null };
  }

  async revisions(userId: string, id: string) {
    const [document] = await this.db
      .select({ projectId: documents.projectId })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    await this.access(userId, document.projectId);
    return this.revisionsProject(document.projectId, id);
  }

  async revisionsForAgent(principal: AgentPrincipal, id: string) {
    return this.revisionsProject(principal.projectId, id);
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
    return { revision: revisionJson(revision) };
  }
}
