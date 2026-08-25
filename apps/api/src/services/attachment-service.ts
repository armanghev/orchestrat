import { randomUUID } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  type CreateMultipartUploadCommandOutput,
  DeleteObjectCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListPartsCommand,
  type ListPartsCommandOutput,
  type GetObjectCommandOutput,
  GetObjectCommand,
  S3Client,
  PutObjectCommand,
  UploadPartCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  documentAttachmentUploads,
  documentAttachments,
  documents,
  projects,
  type Database
} from "@orchestrat/db";
import type { AgentPrincipal } from "./agent-service.js";
import { insertProjectEvent } from "./agent-service.js";
import type {
  CreateAttachmentUploadRequest,
  AttachmentUploadMode
} from "@orchestrat/protocol";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { ApiError } from "./api-error.js";
import { PermissionService } from "./permission-service.js";
import type { DocumentStorageConfig } from "./document-service.js";
import { AttachmentDownloadTicketStore } from "../realtime/realtime.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;
const PROJECT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;
const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;
const PART_SIZE_BYTES = 16 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const URL_TTL_SECONDS = 15 * 60;
const DOWNLOAD_TTL_MS = 60_000;
const attachmentJson = (value: typeof documentAttachments.$inferSelect) => ({
  id: value.id,
  document_id: value.documentId,
  filename: value.filename,
  content_type: value.mimeType,
  size_bytes: value.sizeBytes,
  created_at: value.createdAt.toISOString()
});
const attachmentDisposition = (filename: string) => {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\\r\n]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};
export class AttachmentService {
  private readonly permissions: PermissionService;
  private readonly storage: S3Client | null;
  constructor(
    private readonly db: Database,
    private readonly config?: DocumentStorageConfig,
    private readonly downloadTickets = new AttachmentDownloadTicketStore()
  ) {
    this.permissions = new PermissionService(db);
    this.storage =
      config?.client ??
      (config
        ? new S3Client({
            forcePathStyle: true,
            region: config.region,
            endpoint: config.endpoint,
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey
            }
          })
        : null);
  }
  private requireStorage() {
    if (!this.storage || !this.config)
      throw new ApiError(
        503,
        "STORAGE_UPLOAD_FAILED",
        "Private attachment storage is not configured."
      );
    return { storage: this.storage, config: this.config };
  }
  private key(projectId: string, documentId: string, attachmentId: string) {
    return `document-attachments/v1/${projectId}/${documentId}/${attachmentId}`;
  }
  private async document(projectId: string, documentId: string, write = false) {
    const [document] = await this.db
      .select()
      .from(documents)
      .where(
        and(eq(documents.id, documentId), eq(documents.projectId, projectId))
      )
      .limit(1);
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    if (write && document.archivedAt)
      throw new ApiError(
        409,
        "DOCUMENT_ARCHIVED",
        "Archived documents are read-only."
      );
    return document;
  }
  private async documentTx(
    tx: Transaction,
    projectId: string,
    documentId: string,
    write = false
  ) {
    const [document] = await tx
      .select()
      .from(documents)
      .where(
        and(eq(documents.id, documentId), eq(documents.projectId, projectId))
      )
      .for("update");
    if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    if (write && document.archivedAt)
      throw new ApiError(
        409,
        "DOCUMENT_ARCHIVED",
        "Archived documents are read-only."
      );
    return document;
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
  private async lockProject(tx: Transaction, projectId: string) {
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
  }
  private async quota(tx: Transaction, projectId: string) {
    const [completed] = await tx
      .select({
        value: sql<string>`coalesce(sum(${documentAttachments.sizeBytes}), 0)`
      })
      .from(documentAttachments)
      .where(eq(documentAttachments.projectId, projectId));
    const [reserved] = await tx
      .select({
        value: sql<string>`coalesce(sum(${documentAttachmentUploads.reservedBytes}), 0)`
      })
      .from(documentAttachmentUploads)
      .where(
        and(
          eq(documentAttachmentUploads.projectId, projectId),
          eq(documentAttachmentUploads.status, "pending"),
          gt(documentAttachmentUploads.expiresAt, new Date())
        )
      );
    return Number(completed?.value ?? 0) + Number(reserved?.value ?? 0);
  }
  private uploadJson(
    value: typeof documentAttachmentUploads.$inferSelect,
    extra: Record<string, unknown> = {}
  ) {
    return {
      id: value.id,
      mode: value.uploadMode,
      upload_id: value.providerUploadId ?? undefined,
      expires_at: value.expiresAt.toISOString(),
      status: value.status,
      ...extra
    };
  }
  private async parts(upload: typeof documentAttachmentUploads.$inferSelect) {
    if (
      !upload.providerUploadId ||
      upload.uploadMode !== "multipart" ||
      !this.storage ||
      !this.config
    )
      return [];
    let listed: ListPartsCommandOutput;
    try {
      listed = await this.storage.send(
        new ListPartsCommand({
          Bucket: this.config.bucket,
          Key: this.key(upload.projectId, upload.documentId, upload.id),
          UploadId: upload.providerUploadId
        })
      );
    } catch {
      throw new ApiError(
        502,
        "STORAGE_UPLOAD_FAILED",
        "Storage could not inspect the multipart upload."
      );
    }
    return (listed.Parts ?? []).flatMap((part) =>
      part.PartNumber && part.ETag
        ? [{ part_number: part.PartNumber, etag: part.ETag }]
        : []
    );
  }
  async list(userId: string, documentId: string) {
    const [row] = await this.db
      .select({ projectId: documents.projectId })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    await this.access(userId, row.projectId);
    const rows = await this.db
      .select()
      .from(documentAttachments)
      .where(eq(documentAttachments.documentId, documentId))
      .orderBy(asc(documentAttachments.createdAt), asc(documentAttachments.id));
    return { attachments: rows.map(attachmentJson) };
  }
  async listForAgent(principal: AgentPrincipal, documentId: string) {
    await this.document(principal.projectId, documentId);
    const rows = await this.db
      .select()
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.projectId, principal.projectId),
          eq(documentAttachments.documentId, documentId)
        )
      )
      .orderBy(asc(documentAttachments.createdAt), asc(documentAttachments.id));
    return { attachments: rows.map(attachmentJson) };
  }
  private async createProject(
    projectId: string,
    documentId: string,
    input: CreateAttachmentUploadRequest,
    actorType: "human" | "agent",
    actorId: string
  ) {
    this.requireStorage();
    await this.document(projectId, documentId, true);
    if (input.size_bytes > MAX_ATTACHMENT_BYTES)
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "Attachments are limited to 2 GiB."
      );
    // The server owns the threshold; client-provided mode is ignored so it
    // cannot force a single PUT for an object that requires multipart upload.
    const mode: AttachmentUploadMode =
      input.size_bytes > MULTIPART_THRESHOLD_BYTES ? "multipart" : "direct";
    const uploadMode = mode === "direct" ? "single" : "multipart";
    const uploadId = randomUUID();
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS);
    let providerUploadId: string | null = null;
    if (uploadMode === "multipart") {
      const { storage, config } = this.requireStorage();
      let created: CreateMultipartUploadCommandOutput;
      try {
        created = await storage.send(
          new CreateMultipartUploadCommand({
            Bucket: config.bucket,
            Key: this.key(projectId, documentId, uploadId),
            ContentType: input.content_type
          })
        );
      } catch {
        throw new ApiError(
          502,
          "STORAGE_UPLOAD_FAILED",
          "Storage could not create the multipart upload."
        );
      }
      providerUploadId = created.UploadId ?? null;
      if (!providerUploadId)
        throw new ApiError(
          503,
          "STORAGE_UPLOAD_FAILED",
          "Storage did not create an upload session."
        );
    }
    try {
      const row = await this.db.transaction(async (tx) => {
        await this.lockProject(tx, projectId);
        await this.documentTx(tx, projectId, documentId, true);
        if (
          (await this.quota(tx, projectId)) + input.size_bytes >
          PROJECT_QUOTA_BYTES
        )
          throw new ApiError(
            409,
            "ATTACHMENT_QUOTA_EXCEEDED",
            "Project attachment quota exceeded."
          );
        const [inserted] = await tx
          .insert(documentAttachmentUploads)
          .values({
            id: uploadId,
            projectId,
            documentId,
            filename: input.filename,
            mimeType: input.content_type,
            reservedBytes: input.size_bytes,
            uploadMode,
            providerUploadId,
            actorType,
            ...(actorType === "human"
              ? { actorUserId: actorId }
              : { actorAgentId: actorId }),
            expiresAt
          })
          .returning();
        return inserted;
      });
      const extra =
        uploadMode === "single"
          ? {
              upload_url: await getSignedUrl(
                this.storage! as any,
                new PutObjectCommand({
                  Bucket: this.config!.bucket,
                  Key: this.key(projectId, documentId, uploadId)
                }),
                { expiresIn: URL_TTL_SECONDS }
              ),
              mode: "single"
            }
          : {
              upload_id: providerUploadId,
              part_size_bytes: PART_SIZE_BYTES,
              mode: "multipart"
            };
      return { upload: this.uploadJson(row, extra) };
    } catch (error) {
      if (providerUploadId && this.storage && this.config)
        await this.storage
          .send(
            new AbortMultipartUploadCommand({
              Bucket: this.config.bucket,
              Key: this.key(projectId, documentId, uploadId),
              UploadId: providerUploadId
            })
          )
          .catch(() => undefined);
      throw error;
    }
  }
  async create(
    userId: string,
    documentId: string,
    input: CreateAttachmentUploadRequest
  ) {
    const [row] = await this.db
      .select({ projectId: documents.projectId })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Document not found.");
    await this.access(userId, row.projectId, true);
    return this.createProject(
      row.projectId,
      documentId,
      input,
      "human",
      userId
    );
  }
  async createForAgent(
    principal: AgentPrincipal,
    documentId: string,
    input: CreateAttachmentUploadRequest
  ) {
    return this.createProject(
      principal.projectId,
      documentId,
      input,
      "agent",
      principal.agentId
    );
  }
  private async findUpload(id: string) {
    const [row] = await this.db
      .select()
      .from(documentAttachmentUploads)
      .where(eq(documentAttachmentUploads.id, id))
      .limit(1);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Upload session not found.");
    if (row.expiresAt <= new Date() && row.status === "pending") {
      await this.db
        .update(documentAttachmentUploads)
        .set({ status: "expired" })
        .where(
          and(
            eq(documentAttachmentUploads.id, id),
            eq(documentAttachmentUploads.status, "pending")
          )
        );
      throw new ApiError(
        409,
        "ATTACHMENT_UPLOAD_EXPIRED",
        "Upload session has expired."
      );
    }
    return row;
  }
  private assertUploadDocument(
    row: typeof documentAttachmentUploads.$inferSelect,
    documentId?: string
  ) {
    if (documentId && row.documentId !== documentId)
      throw new ApiError(404, "NOT_FOUND", "Upload session not found.");
  }
  private requirePending(row: typeof documentAttachmentUploads.$inferSelect) {
    if (row.status !== "pending")
      throw new ApiError(409, "CONFLICT", "Upload session is not pending.");
  }
  async inspect(userId: string, id: string, documentId?: string) {
    const row = await this.findUpload(id);
    this.assertUploadDocument(row, documentId);
    await this.access(userId, row.projectId);
    return {
      upload: this.uploadJson(row, {
        completed_parts: row.status === "pending" ? await this.parts(row) : []
      })
    };
  }
  async inspectForAgent(
    principal: AgentPrincipal,
    id: string,
    documentId?: string
  ) {
    const row = await this.findUpload(id);
    this.assertUploadDocument(row, documentId);
    if (row.projectId !== principal.projectId)
      throw new ApiError(404, "NOT_FOUND", "Upload session not found.");
    return {
      upload: this.uploadJson(row, {
        completed_parts: row.status === "pending" ? await this.parts(row) : []
      })
    };
  }
  private async signParts(
    row: typeof documentAttachmentUploads.$inferSelect,
    numbers: number[]
  ) {
    this.requirePending(row);
    if (
      row.uploadMode !== "multipart" ||
      !row.providerUploadId ||
      !this.config ||
      !this.storage
    )
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "This upload is not multipart."
      );
    const maxPart = Math.ceil(row.reservedBytes / PART_SIZE_BYTES);
    if (
      numbers.length > 100 ||
      new Set(numbers).size !== numbers.length ||
      numbers.some((number) => number < 1 || number > maxPart)
    )
      throw new ApiError(400, "VALIDATION_ERROR", "Part numbers are invalid.");
    return {
      parts: await Promise.all(
        numbers.map(async (part_number) => ({
          part_number,
          upload_url: await getSignedUrl(
            this.storage! as any,
            new UploadPartCommand({
              Bucket: this.config!.bucket,
              Key: this.key(row.projectId, row.documentId, row.id),
              UploadId: row.providerUploadId!,
              PartNumber: part_number
            }),
            { expiresIn: URL_TTL_SECONDS }
          )
        }))
      )
    };
  }
  async signPartsForUser(
    userId: string,
    id: string,
    numbers: number[],
    documentId?: string
  ) {
    const row = await this.findUpload(id);
    this.assertUploadDocument(row, documentId);
    await this.access(userId, row.projectId, true);
    await this.document(row.projectId, row.documentId, true);
    return this.signParts(row, numbers);
  }
  async signPartsForAgent(
    principal: AgentPrincipal,
    id: string,
    numbers: number[],
    documentId?: string
  ) {
    const row = await this.findUpload(id);
    this.assertUploadDocument(row, documentId);
    if (row.projectId !== principal.projectId)
      throw new ApiError(404, "NOT_FOUND", "Upload session not found.");
    await this.document(row.projectId, row.documentId, true);
    return this.signParts(row, numbers);
  }
  async refresh(userId: string, id: string, documentId?: string) {
    const row = await this.findUpload(id);
    this.assertUploadDocument(row, documentId);
    this.requirePending(row);
    await this.access(userId, row.projectId, true);
    await this.document(row.projectId, row.documentId, true);
    return {
      upload: this.uploadJson(
        row,
        row.uploadMode === "single"
          ? {
              upload_url: await getSignedUrl(
                this.storage! as any,
                new PutObjectCommand({
                  Bucket: this.config!.bucket,
                  Key: this.key(row.projectId, row.documentId, row.id)
                }),
                { expiresIn: URL_TTL_SECONDS }
              )
            }
          : {
              upload_id: row.providerUploadId,
              part_size_bytes: PART_SIZE_BYTES,
              completed_parts: await this.parts(row)
            }
      )
    };
  }
  async refreshForAgent(
    principal: AgentPrincipal,
    id: string,
    documentId?: string
  ) {
    const row = await this.findUpload(id);
    this.assertUploadDocument(row, documentId);
    this.requirePending(row);
    if (row.projectId !== principal.projectId)
      throw new ApiError(404, "NOT_FOUND", "Upload session not found.");
    await this.document(row.projectId, row.documentId, true);
    return {
      upload: this.uploadJson(
        row,
        row.uploadMode === "single"
          ? {
              upload_url: await getSignedUrl(
                this.storage! as any,
                new PutObjectCommand({
                  Bucket: this.config!.bucket,
                  Key: this.key(row.projectId, row.documentId, row.id)
                }),
                { expiresIn: URL_TTL_SECONDS }
              )
            }
          : {
              upload_id: row.providerUploadId,
              part_size_bytes: PART_SIZE_BYTES,
              completed_parts: await this.parts(row)
            }
      )
    };
  }
  private async completeProject(
    row: typeof documentAttachmentUploads.$inferSelect
  ) {
    const { storage, config } = this.requireStorage();
    if (row.status !== "pending")
      throw new ApiError(409, "CONFLICT", "Upload session is not pending.");
    // Recheck archive state before mutating provider state. The transaction
    // below repeats this check under the project lock for the race window.
    await this.document(row.projectId, row.documentId, true);
    let head: HeadObjectCommandOutput | undefined;
    if (row.uploadMode === "multipart") {
      if (!row.providerUploadId)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Multipart completion requires an upload id."
        );
      const key = this.key(row.projectId, row.documentId, row.id);
      let known: Array<{ part_number: number; etag: string }> | undefined;
      try {
        known = await this.parts(row);
      } catch {
        // A prior completion may have committed the object while its API
        // request or database transaction failed. Reuse that exact object.
        try {
          head = await storage.send(
            new HeadObjectCommand({ Bucket: config.bucket, Key: key })
          );
        } catch {
          throw new ApiError(
            502,
            "STORAGE_UPLOAD_FAILED",
            "Storage could not complete the attachment upload."
          );
        }
      }
      if (!head) {
        const merged = new Map(
          (known ?? []).map((part) => [part.part_number, part.etag])
        );
        const expectedCount = Math.ceil(row.reservedBytes / PART_SIZE_BYTES);
        if (
          merged.size !== expectedCount ||
          [...merged.keys()].some((part) => part < 1 || part > expectedCount)
        )
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "Multipart completion requires every uploaded part."
          );
        try {
          await storage.send(
            new CompleteMultipartUploadCommand({
              Bucket: config.bucket,
              Key: key,
              UploadId: row.providerUploadId,
              MultipartUpload: {
                // The provider's ListParts response is authoritative. Client
                // ETags are only a compatibility hint and are not trusted.
                Parts: [...merged.entries()]
                  .sort(([a], [b]) => a - b)
                  .map(([PartNumber, ETag]) => ({ PartNumber, ETag }))
              }
            })
          );
        } catch (error) {
          if (error instanceof ApiError) throw error;
          try {
            // CompleteMultipartUpload can commit before its request fails.
            head = await storage.send(
              new HeadObjectCommand({ Bucket: config.bucket, Key: key })
            );
          } catch {
            throw new ApiError(
              502,
              "STORAGE_UPLOAD_FAILED",
              "Storage could not complete the attachment upload."
            );
          }
        }
      }
      if (!head) {
        try {
          head = await storage.send(
            new HeadObjectCommand({ Bucket: config.bucket, Key: key })
          );
        } catch {
          throw new ApiError(
            502,
            "STORAGE_UPLOAD_FAILED",
            "Storage could not inspect the attachment upload."
          );
        }
      }
    } else {
      try {
        head = await storage.send(
          new HeadObjectCommand({
            Bucket: config.bucket,
            Key: this.key(row.projectId, row.documentId, row.id)
          })
        );
      } catch {
        throw new ApiError(
          502,
          "STORAGE_UPLOAD_FAILED",
          "Storage could not inspect the attachment upload."
        );
      }
    }
    if (!head)
      throw new ApiError(
        502,
        "STORAGE_UPLOAD_FAILED",
        "Storage could not inspect the attachment upload."
      );
    if (Number(head.ContentLength ?? -1) !== row.reservedBytes) {
      await storage
        .send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: this.key(row.projectId, row.documentId, row.id)
          })
        )
        .catch(() => undefined);
      await this.db
        .update(documentAttachmentUploads)
        .set({ status: "aborted" })
        .where(eq(documentAttachmentUploads.id, row.id));
      throw new ApiError(
        409,
        "STORAGE_UPLOAD_FAILED",
        "Uploaded object size does not match the reservation."
      );
    }
    return this.db.transaction(async (tx) => {
      await this.lockProject(tx, row.projectId);
      await this.documentTx(tx, row.projectId, row.documentId, true);
      const [current] = await tx
        .select()
        .from(documentAttachmentUploads)
        .where(eq(documentAttachmentUploads.id, row.id))
        .for("update");
      if (!current || current.status !== "pending")
        throw new ApiError(409, "CONFLICT", "Upload session is not pending.");
      const [attachment] = await tx
        .insert(documentAttachments)
        .values({
          id: current.id,
          projectId: current.projectId,
          documentId: current.documentId,
          filename: current.filename,
          mimeType: current.mimeType,
          sizeBytes: current.reservedBytes,
          addedByType: current.actorType,
          ...(current.actorType === "human"
            ? { addedByUserId: current.actorUserId! }
            : { addedByAgentId: current.actorAgentId! })
        })
        .returning();
      const [updated] = await tx
        .update(documentAttachmentUploads)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(documentAttachmentUploads.id, current.id))
        .returning();
      await insertProjectEvent(tx, {
        projectId: current.projectId,
        actorUserId: current.actorUserId,
        actorAgentId: current.actorAgentId,
        entityId: current.documentId,
        type: "document.attachment_added",
        payload: {
          attachment_id: attachment.id,
          filename: attachment.filename,
          size_bytes: attachment.sizeBytes
        }
      });
      return {
        attachment: attachmentJson(attachment),
        upload: this.uploadJson(updated)
      };
    });
  }
  private async completedProject(
    row: typeof documentAttachmentUploads.$inferSelect
  ) {
    const [attachment] = await this.db
      .select()
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.id, row.id),
          eq(documentAttachments.projectId, row.projectId),
          eq(documentAttachments.documentId, row.documentId)
        )
      )
      .limit(1);
    if (!attachment)
      throw new ApiError(
        503,
        "DOCUMENT_CONTENT_UNAVAILABLE",
        "Attachment metadata is unavailable."
      );
    return {
      attachment: attachmentJson(attachment),
      upload: this.uploadJson(row)
    };
  }
  async complete(
    userId: string,
    id: string,
    _parts?: Array<{ part_number: number; etag: string }>,
    documentId?: string
  ) {
    const row = await this.findUpload(id);
    this.assertUploadDocument(row, documentId);
    await this.access(userId, row.projectId, row.status === "pending");
    if (row.status === "completed") return this.completedProject(row);
    return this.completeProject(row);
  }
  async completeForAgent(
    principal: AgentPrincipal,
    id: string,
    _parts?: Array<{ part_number: number; etag: string }>,
    documentId?: string
  ) {
    const row = await this.findUpload(id);
    this.assertUploadDocument(row, documentId);
    if (row.projectId !== principal.projectId)
      throw new ApiError(404, "NOT_FOUND", "Upload session not found.");
    if (row.status === "completed") return this.completedProject(row);
    return this.completeProject(row);
  }
  async abort(userId: string, id: string, documentId?: string) {
    const row = await this.findUpload(id);
    this.assertUploadDocument(row, documentId);
    await this.access(userId, row.projectId, true);
    return this.abortProject(row);
  }
  async abortForAgent(
    principal: AgentPrincipal,
    id: string,
    documentId?: string
  ) {
    const row = await this.findUpload(id);
    this.assertUploadDocument(row, documentId);
    if (row.projectId !== principal.projectId)
      throw new ApiError(404, "NOT_FOUND", "Upload session not found.");
    return this.abortProject(row);
  }
  private async abortProject(
    row: typeof documentAttachmentUploads.$inferSelect
  ) {
    if (row.status !== "pending")
      throw new ApiError(409, "CONFLICT", "Upload session is not pending.");
    if (this.storage && this.config) {
      if (row.providerUploadId)
        await this.storage
          .send(
            new AbortMultipartUploadCommand({
              Bucket: this.config.bucket,
              Key: this.key(row.projectId, row.documentId, row.id),
              UploadId: row.providerUploadId
            })
          )
          .catch(() => undefined);
      else
        await this.storage
          .send(
            new DeleteObjectCommand({
              Bucket: this.config.bucket,
              Key: this.key(row.projectId, row.documentId, row.id)
            })
          )
          .catch(() => undefined);
    }
    await this.db
      .update(documentAttachmentUploads)
      .set({ status: "aborted" })
      .where(eq(documentAttachmentUploads.id, row.id));
    return undefined;
  }
  private issueDownloadTicket(row: typeof documentAttachments.$inferSelect) {
    this.requireStorage();
    const { ticket } = this.downloadTickets.issue(
      row.id,
      row.projectId,
      row.documentId,
      DOWNLOAD_TTL_MS
    );
    return {
      download_url: `/api/v1/attachments/download?ticket=${encodeURIComponent(ticket)}`
    };
  }

  async download(userId: string, id: string, documentId?: string) {
    const [row] = await this.db
      .select()
      .from(documentAttachments)
      .where(eq(documentAttachments.id, id))
      .limit(1);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Attachment not found.");
    if (documentId && row.documentId !== documentId)
      throw new ApiError(404, "NOT_FOUND", "Attachment not found.");
    await this.access(userId, row.projectId);
    return this.issueDownloadTicket(row);
  }
  async downloadForAgent(
    principal: AgentPrincipal,
    id: string,
    documentId?: string
  ) {
    const [row] = await this.db
      .select()
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.id, id),
          eq(documentAttachments.projectId, principal.projectId)
        )
      )
      .limit(1);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Attachment not found.");
    if (documentId && row.documentId !== documentId)
      throw new ApiError(404, "NOT_FOUND", "Attachment not found.");
    return this.issueDownloadTicket(row);
  }

  async downloadByTicket(ticket: string) {
    const scope = this.downloadTickets.consume(ticket);
    if (!scope)
      throw new ApiError(
        401,
        "UNAUTHENTICATED",
        "Attachment download ticket is invalid."
      );
    const [row] = await this.db
      .select()
      .from(documentAttachments)
      .where(eq(documentAttachments.id, scope.attachmentId))
      .limit(1);
    if (
      !row ||
      row.projectId !== scope.projectId ||
      row.documentId !== scope.documentId
    )
      throw new ApiError(404, "NOT_FOUND", "Attachment not found.");
    const { storage, config } = this.requireStorage();
    let object: GetObjectCommandOutput;
    try {
      object = await storage.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: this.key(row.projectId, row.documentId, row.id)
        })
      );
    } catch {
      throw new ApiError(
        503,
        "DOCUMENT_CONTENT_UNAVAILABLE",
        "Attachment content is unavailable."
      );
    }
    const body = object.Body;
    if (!body)
      throw new ApiError(
        503,
        "DOCUMENT_CONTENT_UNAVAILABLE",
        "Attachment content is unavailable."
      );
    if (
      object.ContentLength !== undefined &&
      object.ContentLength !== row.sizeBytes
    ) {
      const destroy = (body as { destroy?: () => void }).destroy;
      destroy?.call(body);
      throw new ApiError(
        503,
        "DOCUMENT_CONTENT_UNAVAILABLE",
        "Attachment content is unavailable."
      );
    }
    return {
      body,
      contentLength: object.ContentLength ?? row.sizeBytes,
      contentDisposition: attachmentDisposition(row.filename)
    };
  }
  async remove(userId: string, documentId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.id, id),
          eq(documentAttachments.documentId, documentId)
        )
      )
      .limit(1);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Attachment not found.");
    await this.access(userId, row.projectId, true);
    await this.document(row.projectId, documentId, true);
    await this.db.transaction(async (tx) => {
      await this.lockProject(tx, row.projectId);
      await tx
        .delete(documentAttachments)
        .where(eq(documentAttachments.id, id));
      await insertProjectEvent(tx, {
        projectId: row.projectId,
        actorUserId: userId,
        entityId: documentId,
        type: "document.attachment_removed",
        payload: { attachment_id: id, filename: row.filename }
      });
    });
    const { storage, config } = this.requireStorage();
    await storage
      .send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: this.key(row.projectId, row.documentId, row.id)
        })
      )
      .catch(() => undefined);
  }
  async removeForAgent(
    principal: AgentPrincipal,
    documentId: string,
    id: string
  ) {
    const [row] = await this.db
      .select()
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.id, id),
          eq(documentAttachments.documentId, documentId),
          eq(documentAttachments.projectId, principal.projectId)
        )
      )
      .limit(1);
    if (!row) throw new ApiError(404, "NOT_FOUND", "Attachment not found.");
    await this.document(principal.projectId, documentId, true);
    await this.db.transaction(async (tx) => {
      await this.lockProject(tx, principal.projectId);
      await tx
        .delete(documentAttachments)
        .where(eq(documentAttachments.id, id));
      await insertProjectEvent(tx, {
        projectId: principal.projectId,
        actorAgentId: principal.agentId,
        entityId: documentId,
        type: "document.attachment_removed",
        payload: { attachment_id: id, filename: row.filename }
      });
    });
    const { storage, config } = this.requireStorage();
    await storage
      .send(
        new DeleteObjectCommand({
          Bucket: config.bucket,
          Key: this.key(row.projectId, row.documentId, row.id)
        })
      )
      .catch(() => undefined);
  }
}
