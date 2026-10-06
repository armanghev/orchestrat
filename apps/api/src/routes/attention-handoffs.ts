import {
  createHandoffRequestSchema,
  idempotencyKeySchema,
  projectTaskParamsSchema,
  recordWakeRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../services/api-error.js";
import { humanBranchSelector } from "../services/branch-context.js";
import type { AttentionRouteOptions } from "./attention.js";

// Handoffs are retried by agents after ambiguous responses, so the key is
// required rather than optional (the same rule as lifecycle hooks).
const requiredKey = (headers: Record<string, unknown>) => {
  const key = headers["idempotency-key"];
  if (typeof key !== "string")
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "An Idempotency-Key header is required."
    );
  return idempotencyKeySchema.parse(key);
};

export async function agentHandoffRoutes(
  app: FastifyInstance,
  options: AttentionRouteOptions
) {
  app.post("/handoffs", async (request, reply) => {
    const key = requiredKey(request.headers);
    const result = await options.handoffs.createAgent(
      request.agentPrincipal!,
      createHandoffRequestSchema.parse(request.body),
      key
    );
    return reply.code(result.status).send(result.body);
  });
  app.post("/wakes", async (request, reply) =>
    reply
      .code(201)
      .send(
        await options.handoffs.recordWake(
          request.agentPrincipal!,
          recordWakeRequestSchema.parse(request.body)
        )
      )
  );
}

export async function humanHandoffRoutes(
  app: FastifyInstance,
  options: AttentionRouteOptions
) {
  app.post("/projects/:projectId/handoffs", async (request, reply) => {
    const key = requiredKey(request.headers);
    const result = await options.handoffs.createHuman(
      request.userId,
      projectTaskParamsSchema.parse(request.params).projectId,
      createHandoffRequestSchema.parse(request.body),
      key,
      humanBranchSelector(request.query)
    );
    return reply.code(result.status).send(result.body);
  });
}
