import {
  acknowledgeAttentionRequestSchema,
  idParamsSchema,
  markCommentsReadRequestSchema,
  projectTaskParamsSchema,
  taskWatchRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { AttentionService } from "../services/attention-service.js";
import type { AttentionWaitHub } from "../services/attention-wait-hub.js";
import type { HandoffService } from "../services/handoff-service.js";
import type { TaskStatusService } from "../services/task-status-service.js";
import {
  agentHandoffRoutes,
  humanHandoffRoutes
} from "./attention-handoffs.js";
import { agentStatusRoutes, humanStatusRoutes } from "./attention-status.js";
import { agentWaitRoutes, humanWaitRoutes } from "./attention-wait.js";

export type AttentionRouteOptions = {
  attention: AttentionService;
  waits: AttentionWaitHub;
  statuses: TaskStatusService;
  handoffs: HandoffService;
};

export async function agentAttentionRoutes(
  app: FastifyInstance,
  options: AttentionRouteOptions
) {
  app.get("/attention", (request) =>
    options.attention.summaryAgent(request.agentPrincipal!)
  );
  app.post("/attention/acknowledge", (request) =>
    options.attention.acknowledgeAgent(
      request.agentPrincipal!,
      acknowledgeAttentionRequestSchema.parse(request.body)
    )
  );
  app.post("/tasks/:id/watch", (request) =>
    options.attention.watchAgent(
      request.agentPrincipal!,
      idParamsSchema.parse(request.params).id,
      taskWatchRequestSchema.parse(request.body).watching
    )
  );
  await app.register(agentWaitRoutes, options);
  await app.register(agentStatusRoutes, options);
  await app.register(agentHandoffRoutes, options);
}

export async function humanAttentionRoutes(
  app: FastifyInstance,
  options: AttentionRouteOptions
) {
  app.get("/projects/:projectId/attention", (request) =>
    options.attention.summaryHuman(
      request.userId,
      projectTaskParamsSchema.parse(request.params).projectId
    )
  );
  app.get("/projects/:projectId/attention/tasks", (request) =>
    options.attention.taskOverlaysHuman(
      request.userId,
      projectTaskParamsSchema.parse(request.params).projectId
    )
  );
  app.post("/tasks/:id/watch", (request) =>
    options.attention.watchHuman(
      request.userId,
      idParamsSchema.parse(request.params).id,
      taskWatchRequestSchema.parse(request.body).watching
    )
  );
  app.post("/tasks/:id/comments/read", (request) =>
    options.attention.markReadHuman(
      request.userId,
      idParamsSchema.parse(request.params).id,
      markCommentsReadRequestSchema.parse(request.body).through_sequence
    )
  );
  await app.register(humanWaitRoutes, options);
  await app.register(humanStatusRoutes, options);
  await app.register(humanHandoffRoutes, options);
}
