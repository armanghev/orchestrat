import {
  attachmentPartsResponseSchema,
  attachmentSchema,
  attachmentUploadResponseSchema,
  documentRevisionSchema,
  documentRevisionSummaryResponseSchema,
  documentSchema,
  editDocumentRequestSchema,
  renameDocumentRequestSchema
} from "@orchestrat/protocol";
import type {
  AttachmentUpload as ProtocolAttachmentUpload,
  CreateAttachmentUploadRequest,
  DocumentEdit,
  DocumentRevision,
  DocumentRevisionSummary,
  DocumentRevisionSummaryResponse,
  EditDocumentRequest,
  RenameDocumentRequest
} from "@orchestrat/protocol";

export type {
  CreateAttachmentUploadRequest,
  DocumentEdit,
  EditDocumentRequest,
  RenameDocumentRequest
};
export type { DocumentRevisionSummary };
export type DocumentRevisionHistory = DocumentRevisionSummaryResponse;
export type HistoricalDocumentRevision = { revision: DocumentRevision };
export type AttachmentUpload = ProtocolAttachmentUpload & {
  completed_parts?: Array<{ part_number: number; etag: string }>;
};
export type AttachmentPart = {
  part_number: number;
  upload_url: string;
};
export type AttachmentPartsResponse = { parts: AttachmentPart[] };
export type CompletedAttachmentUpload = {
  attachment: import("@orchestrat/protocol").Attachment;
  upload?: AttachmentUpload;
};

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid object response");
  return value as Record<string, unknown>;
};

export function parseEditDocumentRequest(input: EditDocumentRequest) {
  return editDocumentRequestSchema.parse(input);
}

export function parseRenameDocumentRequest(input: RenameDocumentRequest) {
  return renameDocumentRequestSchema.parse(input);
}

export function parseDocumentRevisionHistory(
  value: unknown
): DocumentRevisionHistory {
  return documentRevisionSummaryResponseSchema.parse(value);
}

export function parseHistoricalDocumentRevision(
  value: unknown
): HistoricalDocumentRevision {
  const input = object(value);
  return { revision: documentRevisionSchema.parse(input.revision) };
}

export function parseAttachmentUpload(value: unknown): AttachmentUpload {
  const parsed = attachmentUploadResponseSchema.parse(value);
  const rawUpload = object(object(value).upload);
  const completed = rawUpload.completed_parts;
  if (
    completed !== undefined &&
    (!Array.isArray(completed) ||
      completed.some(
        (part) =>
          !part ||
          typeof part !== "object" ||
          !Number.isInteger((part as { part_number?: unknown }).part_number) ||
          (part as { part_number: number }).part_number < 1 ||
          typeof (part as { etag?: unknown }).etag !== "string" ||
          !(part as { etag: string }).etag.length
      ))
  )
    throw new Error("invalid completed attachment parts");
  return {
    ...parsed.upload,
    ...(Array.isArray(completed) ? { completed_parts: completed } : {})
  };
}

export function parseAttachmentParts(value: unknown): AttachmentPartsResponse {
  return attachmentPartsResponseSchema.parse(value);
}

export function parseCompletedAttachmentUpload(
  value: unknown
): CompletedAttachmentUpload {
  const input = object(value);
  return {
    attachment: attachmentSchema.parse(input.attachment),
    ...(input.upload === undefined
      ? {}
      : { upload: parseAttachmentUpload({ upload: input.upload }) })
  };
}

export const documentMutationResponse = {
  parse(value: unknown) {
    const input = object(value);
    return { document: documentSchema.parse(input.document) };
  }
};
