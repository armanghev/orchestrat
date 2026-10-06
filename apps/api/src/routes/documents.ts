import {
  createDocumentRequestSchema,
  createDocumentFolderRequestSchema,
  documentIdParamsSchema,
  documentHistoryQuerySchema,
  attachmentPartsRequestSchema,
  completeAttachmentUploadRequestSchema,
  createAttachmentUploadRequestSchema,
  documentAttachmentParamsSchema,
  documentAttachmentUploadParamsSchema,
  documentListQuerySchema,
  documentRevisionParamsSchema,
  projectDocumentParamsSchema,
  editDocumentRequestSchema,
  renameDocumentRequestSchema,
  updateDocumentRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { DocumentService } from "../services/document-service.js";
import type { AttachmentService } from "../services/attachment-service.js";
import { humanBranchSelector } from "../services/branch-context.js";

export async function documentRoutes(
  app: FastifyInstance,
  options: {
    documents: DocumentService;
    attachments: AttachmentService;
    expensiveRateLimit: preHandlerHookHandler;
  }
) {
  app.get("/projects/:projectId/documents", (request) =>
    options.documents.list(
      request.userId,
      projectDocumentParamsSchema.parse(request.params).projectId,
      documentListQuerySchema.parse(request.query),
      humanBranchSelector(request.query)
    )
  );
  app.post("/projects/:projectId/documents", async (request, reply) =>
    reply
      .code(201)
      .send(
        await options.documents.create(
          request.userId,
          projectDocumentParamsSchema.parse(request.params).projectId,
          createDocumentRequestSchema.parse(request.body),
          humanBranchSelector(request.query)
        )
      )
  );
  app.post("/projects/:projectId/document-folders", async (request, reply) =>
    reply
      .code(201)
      .send(
        await options.documents.createFolder(
          request.userId,
          projectDocumentParamsSchema.parse(request.params).projectId,
          createDocumentFolderRequestSchema.parse(request.body),
          humanBranchSelector(request.query)
        )
      )
  );
  app.get("/documents/:id", (request) =>
    options.documents.get(
      request.userId,
      documentIdParamsSchema.parse(request.params).id
    )
  );
  app.patch("/documents/:id", (request) =>
    options.documents.update(
      request.userId,
      documentIdParamsSchema.parse(request.params).id,
      updateDocumentRequestSchema.parse(request.body)
    )
  );
  app.post("/documents/:id/edits", (request) =>
    options.documents.edit(
      request.userId,
      documentIdParamsSchema.parse(request.params).id,
      editDocumentRequestSchema.parse(request.body)
    )
  );
  app.patch("/documents/:id/path", (request) =>
    options.documents.rename(
      request.userId,
      documentIdParamsSchema.parse(request.params).id,
      renameDocumentRequestSchema.parse(request.body)
    )
  );
  app.post("/documents/:id/archive", (request) =>
    options.documents.archive(
      request.userId,
      documentIdParamsSchema.parse(request.params).id
    )
  );
  app.post("/documents/:id/restore", (request) =>
    options.documents.restore(
      request.userId,
      documentIdParamsSchema.parse(request.params).id
    )
  );
  app.get("/documents/:id/revisions", (request) =>
    options.documents.revisions(
      request.userId,
      documentIdParamsSchema.parse(request.params).id,
      documentHistoryQuerySchema.parse(request.query)
    )
  );
  app.get("/documents/:id/revisions/:revision", (request) => {
    const params = documentRevisionParamsSchema.parse(request.params);
    return options.documents.revision(
      request.userId,
      params.id,
      params.revision
    );
  });
  app.get("/documents/:documentId/attachments", (request) =>
    options.attachments.list(
      request.userId,
      documentIdParamsSchema.parse({
        id: (request.params as { documentId: string }).documentId
      }).id
    )
  );
  app.post(
    "/documents/:documentId/attachments/uploads",
    { preHandler: options.expensiveRateLimit },
    (request, reply) =>
      options.attachments
        .create(
          request.userId,
          documentIdParamsSchema.parse({
            id: (request.params as { documentId: string }).documentId
          }).id,
          createAttachmentUploadRequestSchema.parse(request.body)
        )
        .then((value) => reply.code(201).send(value))
  );
  app.get("/documents/:documentId/attachments/uploads/:uploadId", (request) =>
    (() => {
      const params = documentAttachmentUploadParamsSchema.parse(request.params);
      return options.attachments.inspect(
        request.userId,
        params.uploadId,
        params.documentId
      );
    })()
  );
  app.post(
    "/documents/:documentId/attachments/uploads/:uploadId/refresh",
    { preHandler: options.expensiveRateLimit },
    (request) => {
      const params = documentAttachmentUploadParamsSchema.parse(request.params);
      return options.attachments.refresh(
        request.userId,
        params.uploadId,
        params.documentId
      );
    }
  );
  app.post(
    "/documents/:documentId/attachments/uploads/:uploadId/parts",
    { preHandler: options.expensiveRateLimit },
    (request) => {
      const params = documentAttachmentUploadParamsSchema.parse(request.params);
      return options.attachments.signPartsForUser(
        request.userId,
        params.uploadId,
        attachmentPartsRequestSchema.parse(request.body).part_numbers,
        params.documentId
      );
    }
  );
  app.post(
    "/documents/:documentId/attachments/uploads/:uploadId/complete",
    { preHandler: options.expensiveRateLimit },
    (request) => {
      const params = documentAttachmentUploadParamsSchema.parse(request.params);
      return options.attachments.complete(
        request.userId,
        params.uploadId,
        completeAttachmentUploadRequestSchema.parse(request.body).parts,
        params.documentId
      );
    }
  );
  app.delete(
    "/documents/:documentId/attachments/uploads/:uploadId",
    { preHandler: options.expensiveRateLimit },
    (request) => {
      const params = documentAttachmentUploadParamsSchema.parse(request.params);
      return options.attachments.abort(
        request.userId,
        params.uploadId,
        params.documentId
      );
    }
  );
  app.delete(
    "/documents/:documentId/attachments/:attachmentId",
    { preHandler: options.expensiveRateLimit },
    (request) =>
      (() => {
        const params = documentAttachmentParamsSchema.parse(request.params);
        return options.attachments.remove(
          request.userId,
          params.documentId,
          params.attachmentId
        );
      })()
  );
  app.post(
    "/documents/:documentId/attachments/:attachmentId/download",
    { preHandler: options.expensiveRateLimit },
    (request) => {
      const params = documentAttachmentParamsSchema.parse(request.params);
      return options.attachments.download(
        request.userId,
        params.attachmentId,
        params.documentId
      );
    }
  );
}
