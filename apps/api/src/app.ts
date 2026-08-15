import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import type { HumanAuth } from "@orchestrat/auth";
import type { Database } from "@orchestrat/db";
import { logger } from "@orchestrat/logger";
import type { ApiErrorResponse, ErrorCode } from "@orchestrat/protocol";
import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";
import { v1Routes } from "./routes/v1.js";
import { ApiError } from "./services/api-error.js";
import { IdentityService } from "./services/identity-service.js";
import { ProjectService } from "./services/project-service.js";

type AppOptions = {
  allowedOrigins: string[];
  auth: HumanAuth;
  closeDatabase?: () => Promise<void>;
  db: Database;
};

const errorResponse = (
  requestId: string,
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {}
): ApiErrorResponse => ({
  error: { code, details, message, request_id: requestId }
});

const rawHeaderEntries = (rawHeaders: string[]) => {
  const entries: [string, string][] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    entries.push([rawHeaders[index]!, rawHeaders[index + 1]!]);
  }
  return entries;
};

export function buildApp(options: AppOptions) {
  const app = Fastify({
    genReqId: () => `req_${randomUUID()}`,
    logger: false
  });
  const identities = new IdentityService(options.db);
  const projects = new ProjectService(options.db);

  app.register(cors, { origin: options.allowedOrigins });
  app.addHook("onRequest", (request, reply, done) => {
    reply.header("x-request-id", request.id);
    done();
  });
  if (options.closeDatabase) {
    app.addHook("onClose", options.closeDatabase);
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.statusCode)
        .send(
          errorResponse(request.id, error.code, error.message, error.details)
        );
    }

    const caught = error as {
      code?: string;
      cause?: { message?: string };
      issues?: unknown;
      message?: string;
      name?: string;
      statusCode?: number;
    };
    if (caught.name === "ZodError" || caught.statusCode === 400) {
      return reply.code(400).send(
        errorResponse(
          request.id,
          "VALIDATION_ERROR",
          "The request is invalid.",
          {
            issues: caught.issues
          }
        )
      );
    }

    if (caught.code === "23505") {
      return reply
        .code(409)
        .send(
          errorResponse(
            request.id,
            "CONFLICT",
            "A record with that slug or email already exists."
          )
        );
    }

    logger.error(
      {
        error: caught.cause?.message ?? caught.message ?? "Unknown error",
        request_id: request.id
      },
      "API request failed"
    );
    return reply
      .code(500)
      .send(errorResponse(request.id, "INTERNAL_ERROR", "The request failed."));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send(errorResponse(request.id, "NOT_FOUND", "Route not found."))
  );

  app.register(healthRoutes);
  app.register(healthRoutes, { prefix: "/api/v1" });
  app.register(
    async (api) => {
      api.decorateRequest("userId", "");
      api.addHook("preHandler", async (request) => {
        const principal = await options.auth.authenticate({
          headers: rawHeaderEntries(request.raw.rawHeaders),
          method: request.method,
          url: `http://${request.headers.host ?? "localhost"}${request.url}`
        });
        if (!principal) {
          throw new ApiError(
            401,
            "UNAUTHENTICATED",
            "Authentication is required."
          );
        }
        request.userId = await identities.resolveUserId(principal);
      });
      api.register(v1Routes, { projects });
    },
    { prefix: "/api/v1" }
  );

  return app;
}
