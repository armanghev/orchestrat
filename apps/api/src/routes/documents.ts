import {
  createDocumentRequestSchema,
  documentIdParamsSchema,
  documentListQuerySchema,
  documentRevisionParamsSchema,
  projectDocumentParamsSchema,
  updateDocumentRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { DocumentService } from "../services/document-service.js";

export async function documentRoutes(
  app: FastifyInstance,
  options: { documents: DocumentService }
) {
  app.get("/projects/:projectId/documents", (request) =>
    options.documents.list(
      request.userId,
      projectDocumentParamsSchema.parse(request.params).projectId,
      documentListQuerySchema.parse(request.query)
    )
  );
  app.post("/projects/:projectId/documents", async (request, reply) =>
    reply
      .code(201)
      .send(
        await options.documents.create(
          request.userId,
          projectDocumentParamsSchema.parse(request.params).projectId,
          createDocumentRequestSchema.parse(request.body)
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
  app.get("/documents/:id/revisions", (request) =>
    options.documents.revisions(
      request.userId,
      documentIdParamsSchema.parse(request.params).id
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
}
