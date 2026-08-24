import {
  realtimeProjectParamsSchema,
  realtimeSocketQuerySchema,
  realtimeTicketRequestSchema,
  realtimeTicketResponseSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { ApiError } from "../services/api-error.js";
import { RealtimeRegistry, RealtimeTicketStore } from "../realtime/realtime.js";

export async function realtimeTicketRoutes(
  app: FastifyInstance,
  options: {
    tickets: RealtimeTicketStore;
    projects: {
      getProject(userId: string, projectId: string): Promise<unknown>;
    };
  }
) {
  app.post("/tickets", async (request) => {
    const input = realtimeTicketRequestSchema.parse(request.body);
    await options.projects.getProject(request.userId, input.project_id);
    const result = options.tickets.issue(input.project_id, request.userId);
    return realtimeTicketResponseSchema.parse({
      ticket: result.ticket,
      expires_at: new Date(result.expiresAt).toISOString()
    });
  });
}

export async function realtimeSocketRoutes(
  app: FastifyInstance,
  options: { tickets: RealtimeTicketStore; registry: RealtimeRegistry }
) {
  app.get<{ Params: { projectId: string }; Querystring: { ticket?: string } }>(
    "/projects/:projectId",
    {
      websocket: true,
      preValidation: async (request) => {
        const projectId = realtimeProjectParamsSchema.parse(
          request.params
        ).projectId;
        const ticket = realtimeSocketQuerySchema.parse(request.query).ticket;
        const record = options.tickets.consume(ticket, projectId);
        if (!record)
          throw new ApiError(
            401,
            "UNAUTHENTICATED",
            "Realtime ticket is invalid."
          );
      }
    },
    (socket: WebSocket, request) => {
      const projectId = realtimeProjectParamsSchema.parse(
        request.params
      ).projectId;
      options.registry.add(projectId, socket);
      socket.on("message", () =>
        socket.close(1003, "Client messages are not supported.")
      );
    }
  );
}
