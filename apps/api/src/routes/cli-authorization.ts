import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { CliAuthorizationService } from "../services/cli-authorization-service.js";
import {
  cliAuthorizationApprovalRequestSchema,
  cliAuthorizationAttemptParamsSchema,
  cliAuthorizationDenyRequestSchema,
  cliAuthorizationPollRequestSchema
} from "@orchestrat/protocol";

export async function cliAuthorizationPublicRoutes(
  app: FastifyInstance,
  options: {
    authorization: CliAuthorizationService;
    createRateLimit: preHandlerHookHandler;
    pollRateLimit: preHandlerHookHandler;
  }
) {
  app.post(
    "/cli/authorization/attempts",
    { preHandler: options.createRateLimit },
    async (_request, reply) =>
      reply.code(201).send(await options.authorization.createAttempt())
  );
  app.post(
    "/cli/authorization/attempts/:attemptId/poll",
    { preHandler: options.pollRateLimit },
    async (request) => {
      const params = cliAuthorizationAttemptParamsSchema.parse(request.params);
      const body = cliAuthorizationPollRequestSchema.parse(request.body);
      return options.authorization.poll(params.attemptId, body.secret);
    }
  );
}

export async function cliAuthorizationHumanRoutes(
  app: FastifyInstance,
  options: { authorization: CliAuthorizationService }
) {
  app.post(
    "/cli/authorization/attempts/:attemptId/approve",
    async (request) => {
      cliAuthorizationApprovalRequestSchema.parse(request.body);
      const params = cliAuthorizationAttemptParamsSchema.parse(request.params);
      return options.authorization.approve(request.userId, params.attemptId);
    }
  );
  app.post("/cli/authorization/attempts/:attemptId/deny", async (request) => {
    cliAuthorizationDenyRequestSchema.parse(request.body);
    const params = cliAuthorizationAttemptParamsSchema.parse(request.params);
    return options.authorization.deny(params.attemptId);
  });
}
