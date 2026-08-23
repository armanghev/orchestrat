import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import type { HumanAuth } from "@orchestrat/auth";
import type { Database } from "@orchestrat/db";
import { logger } from "@orchestrat/logger";
import type { ApiErrorResponse, ErrorCode } from "@orchestrat/protocol";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";
import { agentActionRoutes } from "./routes/agent-actions.js";
import { agentManagementRoutes } from "./routes/agents.js";
import { agentDocumentRoutes } from "./routes/agent-documents.js";
import { documentRoutes } from "./routes/documents.js";
import { v1Routes } from "./routes/v1.js";
import { ApiError } from "./services/api-error.js";
import { AgentService } from "./services/agent-service.js";
import { TaskClaimService } from "./services/task-claim-service.js";
import { IdentityService } from "./services/identity-service.js";
import { ProjectService } from "./services/project-service.js";
import {
  ProfileService,
  type AvatarStorageConfig
} from "./services/profile-service.js";
import { TaskService } from "./services/task-service.js";
import { DocumentService } from "./services/document-service.js";
import {
  realtimeSocketRoutes,
  realtimeTicketRoutes
} from "./routes/realtime.js";
import { RealtimeRegistry, RealtimeTicketStore } from "./realtime/realtime.js";

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
  const agents = new AgentService(options.db);
  const claims = new TaskClaimService(options.db);
  const documents = new DocumentService(options.db);
  const realtimeTickets = new RealtimeTicketStore();
  const realtimeRegistry = new RealtimeRegistry();

  app.register(cors, {
    origin: options.allowedOrigins,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"]
  });
  app.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024, files: 1 }
  });
  app.register(websocket, { options: { maxPayload: 64 * 1024 } });
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
  app.decorateRequest("agentPrincipal", null);
  app.register(
    async (api) => {
      api.decorateRequest("suggestedUsername", null);
      api.decorateRequest("userId", "");
      api.addHook("preHandler", async (request) => {
        const authorization = rawHeaderEntries(request.raw.rawHeaders)
          .filter(([name]) => name.toLowerCase() === "authorization")
          .map(([, value]) => value);
        if (
          authorization.length === 1 &&
          authorization[0]?.match(/^Bearer\s+(orch_agent_\S+)$/)
        ) {
          throw new ApiError(
            401,
            "AGENT_CREDENTIAL_INVALID",
            "Agent credentials are only valid on agent routes."
          );
        }
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
      api.register(realtimeTicketRoutes, {
        projects,
        tickets: realtimeTickets
      });
      api.register(documentRoutes, { documents });
      api.register(agentManagementRoutes, { agents });
    },
    { prefix: "/api/v1" }
  );
  app.register(realtimeSocketRoutes, {
    prefix: "/api/v1/realtime",
    tickets: realtimeTickets,
    registry: realtimeRegistry
  });
  app.register(
    async (api) => {
      api.addHook("preHandler", async (request) => {
        const values = rawHeaderEntries(request.raw.rawHeaders)
          .filter(([name]) => name.toLowerCase() === "authorization")
          .map(([, value]) => value);
        if (values.length !== 1) {
          throw new ApiError(
            401,
            "AGENT_CREDENTIAL_INVALID",
            "Agent credential is invalid."
          );
        }
        const match = values[0]?.match(/^Bearer\s+([^\s]+)$/);
        if (!match || !match[1]?.startsWith("orch_agent_")) {
          throw new ApiError(
            401,
            "AGENT_CREDENTIAL_INVALID",
            "Agent credential is invalid."
          );
        }
        request.agentPrincipal = await agents.authenticate(match[1]);
      });
      api.register(agentActionRoutes, { agents, tasks, claims });
      api.register(agentDocumentRoutes, { documents });
    },
    { prefix: "/api/v1/agent" }
  );

  return app;
}
