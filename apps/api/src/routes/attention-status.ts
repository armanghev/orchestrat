import {
  agentSessionParamsSchema,
  idParamsSchema,
  setTaskStatusRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { AttentionRouteOptions } from "./attention.js";

// Agent status changes use the claim token (spec §9); humans resolve blocks.
export async function agentStatusRoutes(
  app: FastifyInstance,
  options: AttentionRouteOptions
) {
  app.post("/sessions/:sessionId/claims/status", (request) =>
    options.statuses.setStatus(
      request.agentPrincipal!,
      agentSessionParamsSchema.parse(request.params).sessionId,
      setTaskStatusRequestSchema.parse(request.body)
    )
  );
}

export async function humanStatusRoutes(
  app: FastifyInstance,
  options: AttentionRouteOptions
) {
  app.post("/tasks/:id/block/resolve", (request) =>
    options.statuses.resolveBlockHuman(
      request.userId,
      idParamsSchema.parse(request.params).id
    )
  );
}
