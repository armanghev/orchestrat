import {
  createDocumentRequestSchema,
  documentIdParamsSchema,
  documentHistoryQuerySchema,
  attachmentPartsRequestSchema,
  completeAttachmentUploadRequestSchema,
  createAttachmentUploadRequestSchema,
  documentAttachmentParamsSchema,
  documentAttachmentUploadParamsSchema,
  documentListQuerySchema,
  documentRevisionParamsSchema,
  editDocumentRequestSchema,
  renameDocumentRequestSchema,
  updateDocumentRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { DocumentService } from "../services/document-service.js";
import type { AttachmentService } from "../services/attachment-service.js";

export async function agentDocumentRoutes(
  app: FastifyInstance,
  options: { documents: DocumentService; attachments: AttachmentService }
) {
  app.get("/documents", (request) =>
    options.documents.listForAgent(
      request.agentPrincipal!,
      documentListQuerySchema.parse(request.query)
    )
  );
  app.post("/documents", async (request, reply) =>
    reply
      .code(201)
      .send(
        await options.documents.createForAgent(
          request.agentPrincipal!,
          createDocumentRequestSchema.parse(request.body)
        )
      )
  );
  app.get("/documents/:id", (request) =>
    options.documents.getForAgent(
      request.agentPrincipal!,
      documentIdParamsSchema.parse(request.params).id
    )
  );
  app.patch("/documents/:id", (request) =>
    options.documents.updateForAgent(
      request.agentPrincipal!,
      documentIdParamsSchema.parse(request.params).id,
      updateDocumentRequestSchema.parse(request.body)
    )
  );
  app.post("/documents/:id/edits", (request) =>
    options.documents.editForAgent(
      request.agentPrincipal!,
      documentIdParamsSchema.parse(request.params).id,
      editDocumentRequestSchema.parse(request.body)
    )
  );
  app.patch("/documents/:id/path", (request) =>
    options.documents.renameForAgent(
      request.agentPrincipal!,
      documentIdParamsSchema.parse(request.params).id,
      renameDocumentRequestSchema.parse(request.body)
    )
  );
  app.post("/documents/:id/archive", (request) =>
    options.documents.archiveForAgent(
      request.agentPrincipal!,
      documentIdParamsSchema.parse(request.params).id
    )
  );
  app.post("/documents/:id/restore", (request) =>
    options.documents.restoreForAgent(
      request.agentPrincipal!,
      documentIdParamsSchema.parse(request.params).id
    )
  );
  app.get("/documents/:id/revisions", (request) =>
    options.documents.revisionsForAgent(
      request.agentPrincipal!,
      documentIdParamsSchema.parse(request.params).id,
      documentHistoryQuerySchema.parse(request.query)
    )
  );
  app.get("/documents/:id/revisions/:revision", (request) => {
    const params = documentRevisionParamsSchema.parse(request.params);
    return options.documents.revisionForAgent(
      request.agentPrincipal!,
      params.id,
      params.revision
    );
  });
  app.get("/documents/:documentId/attachments", (request) =>
    options.attachments.listForAgent(
      request.agentPrincipal!,
      documentIdParamsSchema.parse({
        id: (request.params as { documentId: string }).documentId
      }).id
    )
  );
  app.post(
    "/documents/:documentId/attachments/uploads",
    async (request, reply) => {
      const documentId = documentIdParamsSchema.parse({
        id: (request.params as { documentId: string }).documentId
      }).id;
      return reply
        .code(201)
        .send(
          await options.attachments.createForAgent(
            request.agentPrincipal!,
            documentId,
            createAttachmentUploadRequestSchema.parse(request.body)
          )
        );
    }
  );
  app.get("/documents/:documentId/attachments/uploads/:uploadId", (request) =>
    (() => {
      const params = documentAttachmentUploadParamsSchema.parse(request.params);
      return options.attachments.inspectForAgent(
        request.agentPrincipal!,
        params.uploadId,
        params.documentId
      );
    })()
  );
  app.post(
    "/documents/:documentId/attachments/uploads/:uploadId/refresh",
    (request) => {
      const params = documentAttachmentUploadParamsSchema.parse(request.params);
      return options.attachments.refreshForAgent(
        request.agentPrincipal!,
        params.uploadId,
        params.documentId
      );
    }
  );
  app.post(
    "/documents/:documentId/attachments/uploads/:uploadId/parts",
    (request) => {
      const params = documentAttachmentUploadParamsSchema.parse(request.params);
      return options.attachments.signPartsForAgent(
        request.agentPrincipal!,
        params.uploadId,
        attachmentPartsRequestSchema.parse(request.body).part_numbers,
        params.documentId
      );
    }
  );
  app.post(
    "/documents/:documentId/attachments/uploads/:uploadId/complete",
    (request) =>
      (() => {
        const params = documentAttachmentUploadParamsSchema.parse(
          request.params
        );
        return options.attachments.completeForAgent(
          request.agentPrincipal!,
          params.uploadId,
          completeAttachmentUploadRequestSchema.parse(request.body).parts,
          params.documentId
        );
      })()
  );
  app.delete(
    "/documents/:documentId/attachments/uploads/:uploadId",
    (request) => {
      const params = documentAttachmentUploadParamsSchema.parse(request.params);
      return options.attachments.abortForAgent(
        request.agentPrincipal!,
        params.uploadId,
        params.documentId
      );
    }
  );
  app.delete("/documents/:documentId/attachments/:attachmentId", (request) =>
    (() => {
      const params = documentAttachmentParamsSchema.parse(request.params);
      return options.attachments.removeForAgent(
        request.agentPrincipal!,
        params.documentId,
        params.attachmentId
      );
    })()
  );
  app.post(
    "/documents/:documentId/attachments/:attachmentId/download",
    (request) => {
      const params = documentAttachmentParamsSchema.parse(request.params);
      return options.attachments.downloadForAgent(
        request.agentPrincipal!,
        params.attachmentId,
        params.documentId
      );
    }
  );
}
