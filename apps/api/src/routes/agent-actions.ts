import {
  agentSessionParamsSchema,
  agentLifecycleHookRequestSchema,
  claimMutationRequestSchema,
  claimTaskRequestSchema,
  completeClaimRequestSchema,
  idParamsSchema,
  idempotencyKeySchema,
  openAgentSessionRequestSchema,
  paginationQuerySchema,
  taskListQuerySchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { AgentService } from "../services/agent-service.js";
import type { TaskClaimService } from "../services/task-claim-service.js";
import type { TaskService } from "../services/task-service.js";
import { ApiError } from "../services/api-error.js";

const taskParamsSchema = idParamsSchema;

export async function agentActionRoutes(
  app: FastifyInstance,
  options: {
    agents: AgentService;
    tasks: TaskService;
    claims: TaskClaimService;
  }
) {
  app.post("/sessions", async (request, reply) =>
    reply
      .code(201)
      .send(
        await options.agents.openSession(
          request.agentPrincipal!,
          openAgentSessionRequestSchema.parse(request.body)
        )
      )
  );
  app.post("/hooks/lifecycle", async (request) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string")
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "An Idempotency-Key header is required."
      );
    return options.agents.ingestLifecycle(
      request.agentPrincipal!,
      agentLifecycleHookRequestSchema.parse(request.body),
      idempotencyKeySchema.parse(key)
    );
  });
  app.post("/sessions/:sessionId/heartbeat", (request) =>
    options.agents.heartbeat(
      request.agentPrincipal!,
      agentSessionParamsSchema.parse(request.params).sessionId
    )
  );
  app.post("/sessions/:sessionId/close", (request) =>
    options.agents.closeSession(
      request.agentPrincipal!,
      agentSessionParamsSchema.parse(request.params).sessionId
    )
  );
  app.get("/tasks", (request) =>
    options.tasks.listForAgent(
      request.agentPrincipal!,
      taskListQuerySchema.parse(request.query)
    )
  );
  app.get("/tasks/:id", (request) =>
    options.tasks.getForAgent(
      request.agentPrincipal!,
      taskParamsSchema.parse(request.params).id
    )
  );
  app.post("/tasks/:id/claim", (request) =>
    options.claims.claim(
      request.agentPrincipal!,
      taskParamsSchema.parse(request.params).id,
      claimTaskRequestSchema.parse(request.body)
    )
  );
  app.post("/sessions/:sessionId/claims/release", (request) =>
    options.claims.release(
      request.agentPrincipal!,
      agentSessionParamsSchema.parse(request.params).sessionId,
      claimMutationRequestSchema.parse(request.body)
    )
  );
  app.post("/sessions/:sessionId/claims/complete", (request) =>
    options.claims.complete(
      request.agentPrincipal!,
      agentSessionParamsSchema.parse(request.params).sessionId,
      completeClaimRequestSchema.parse(request.body)
    )
  );
  app.get("/presence", (request) =>
    options.agents.presenceForProject(request.agentPrincipal!.projectId)
  );
  app.get("/events", (request) =>
    options.agents.listEventsAgent(
      request.agentPrincipal!,
      paginationQuerySchema.parse(request.query)
    )
  );
}
