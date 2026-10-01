import {
  decisionParamsSchema,
  decisionsQuerySchema,
  mergeApplyRequestSchema,
  mergePreviewRequestSchema,
  mergeRunsQuerySchema,
  projectTaskParamsSchema,
  resolveDecisionRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { MergeService } from "../services/merge-service.js";

// Imports, merges and decisions (docs/project-branches.md §6.7). People only:
// agents never import, merge or settle decisions.
export async function humanMergeRoutes(
  app: FastifyInstance,
  options: { merges: MergeService }
) {
  app.post("/projects/:projectId/merges/preview", (request) =>
    options.merges.preview(
      request.userId,
      projectTaskParamsSchema.parse(request.params).projectId,
      mergePreviewRequestSchema.parse(request.body)
    )
  );
  app.post("/projects/:projectId/merges", async (request, reply) => {
    const result = await options.merges.apply(
      request.userId,
      projectTaskParamsSchema.parse(request.params).projectId,
      mergeApplyRequestSchema.parse(request.body),
      request.headers["idempotency-key"] as string | undefined
    );
    return reply.code(result.status).send(result.body);
  });
  app.get("/projects/:projectId/merges", (request) =>
    options.merges.runs(
      request.userId,
      projectTaskParamsSchema.parse(request.params).projectId,
      mergeRunsQuerySchema.parse(request.query)
    )
  );
  app.get("/projects/:projectId/decisions", (request) =>
    options.merges.decisions(
      request.userId,
      projectTaskParamsSchema.parse(request.params).projectId,
      decisionsQuerySchema.parse(request.query)
    )
  );
  app.post(
    "/projects/:projectId/decisions/:decisionId/resolve",
    async (request) => {
      const params = decisionParamsSchema.parse(request.params);
      return options.merges.resolve(
        request.userId,
        params.projectId,
        params.decisionId,
        resolveDecisionRequestSchema.parse(request.body).choice
      );
    }
  );
}
