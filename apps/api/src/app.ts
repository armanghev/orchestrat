import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import type { HumanAuth } from "@orchestrat/auth";
import type { Database } from "@orchestrat/db";
import { logger } from "@orchestrat/logger";
import type { ApiErrorResponse, ErrorCode } from "@orchestrat/protocol";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";
import { v1Routes } from "./routes/v1.js";
import { ApiError } from "./services/api-error.js";
import { IdentityService } from "./services/identity-service.js";
import { ProjectService } from "./services/project-service.js";
import {
  ProfileService,
  type AvatarStorageConfig
} from "./services/profile-service.js";
import { TaskService } from "./services/task-service.js";

type AppOptions = {
  allowedOrigins: string[];
  auth: HumanAuth;
  closeDatabase?: () => Promise<void>;
  db: Database;
  avatarStorage?: AvatarStorageConfig;
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
    logger: true
  });
  const identities = new IdentityService(options.db);
  const projects = new ProjectService(options.db);
  const profiles = new ProfileService(options.db, options.avatarStorage);
  const tasks = new TaskService(options.db);

  app.register(cors, {
    origin: options.allowedOrigins,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"]
  });
  app.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024, files: 1 }
  });
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
    if (
      caught.name === "ZodError" ||
      caught.statusCode === 400 ||
      caught.statusCode === 413
    ) {
      return reply.code(caught.statusCode === 413 ? 413 : 400).send(
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
      api.decorateRequest("suggestedUsername", null);
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
        request.suggestedUsername = principal.username;
        request.userId = await identities.resolveUserId(principal);
      });
      api.register(v1Routes, { projects, profiles, tasks });
    },
    { prefix: "/api/v1" }
  );

  return app;
}
