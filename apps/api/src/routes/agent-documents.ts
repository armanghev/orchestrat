import {
  createDocumentRequestSchema,
  documentIdParamsSchema,
  documentListQuerySchema,
  documentRevisionParamsSchema,
  updateDocumentRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { DocumentService } from "../services/document-service.js";

export async function agentDocumentRoutes(
  app: FastifyInstance,
  options: { documents: DocumentService }
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
  app.get("/documents/:id/revisions", (request) =>
    options.documents.revisionsForAgent(
      request.agentPrincipal!,
      documentIdParamsSchema.parse(request.params).id
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
}
