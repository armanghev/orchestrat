import {
  agentBulkCreateTasksRequestSchema,
  agentBulkUpdateTasksRequestSchema,
  agentSessionParamsSchema,
  agentLifecycleHookRequestSchema,
  claimMutationRequestSchema,
  claimTaskRequestSchema,
  completeClaimRequestSchema,
  createTaskCommentRequestSchema,
  agentCreateTaskRequestSchema,
  idParamsSchema,
  idempotencyKeySchema,
  openAgentSessionRequestSchema,
  paginationQuerySchema,
  taskListQuerySchema,
  taskCommentsQuerySchema,
  agentUpdateTaskRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { AgentService } from "../services/agent-service.js";
import type { TaskClaimService } from "../services/task-claim-service.js";
import type { TaskService } from "../services/task-service.js";
import { ApiError } from "../services/api-error.js";

const taskParamsSchema = idParamsSchema;

// Bulk bodies report the first invalid item by index (with its task_id or
// title) so an agent can fix that item; envelope errors keep the generic shape.
type BulkSchema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: Error & {
          issues: { path: PropertyKey[]; message: string }[];
        };
      };
};
function parseBulk<T>(schema: BulkSchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues.find(
    (candidate) =>
      candidate.path[0] === "tasks" && typeof candidate.path[1] === "number"
  );
  if (!issue) throw parsed.error;
  const index = issue.path[1] as number;
  const item = (body as { tasks?: unknown[] }).tasks?.[index] as
    { task_id?: unknown; title?: unknown } | undefined;
  throw new ApiError(
    400,
    "VALIDATION_ERROR",
    `tasks[${index}] is invalid: ${issue.message}`,
    {
      index,
      ...(typeof item?.task_id === "string" ? { task_id: item.task_id } : {}),
      ...(typeof item?.title === "string" ? { title: item.title } : {}),
      issues: parsed.error.issues.filter(
        (candidate) => candidate.path[1] === index
      )
    }
  );
}

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
  app.get("/project", (request) =>
    options.agents.projectForAgent(request.agentPrincipal!)
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
  app.post("/tasks", async (request, reply) => {
    const result = await options.tasks.createForAgent(
      request.agentPrincipal!,
      agentCreateTaskRequestSchema.parse(request.body),
      request.headers["idempotency-key"] as string | undefined
    );
    return reply.code(result.status).send(result.body);
  });
  app.post("/tasks/bulk", async (request, reply) => {
    const result = await options.tasks.createManyForAgent(
      request.agentPrincipal!,
      parseBulk(agentBulkCreateTasksRequestSchema, request.body),
      request.headers["idempotency-key"] as string | undefined
    );
    return reply.code(result.status).send(result.body);
  });
  app.patch("/tasks/bulk", (request) =>
    options.tasks.updateManyForAgent(
      request.agentPrincipal!,
      parseBulk(agentBulkUpdateTasksRequestSchema, request.body)
    )
  );
  app.get("/tasks/:id", (request) =>
    options.tasks.getForAgent(
      request.agentPrincipal!,
      taskParamsSchema.parse(request.params).id
    )
  );
  app.patch("/tasks/:id", (request) =>
    options.tasks.updateForAgent(
      request.agentPrincipal!,
      taskParamsSchema.parse(request.params).id,
      agentUpdateTaskRequestSchema.parse(request.body)
    )
  );
  app.get("/tasks/:id/comments", (request) => {
    const query = taskCommentsQuerySchema.parse(request.query);
    return options.tasks.commentsForAgent(
      request.agentPrincipal!,
      taskParamsSchema.parse(request.params).id,
      query.limit,
      query.cursor
    );
  });
  app.post("/tasks/:id/comments", async (request, reply) => {
    const result = await options.tasks.createCommentForAgent(
      request.agentPrincipal!,
      taskParamsSchema.parse(request.params).id,
      createTaskCommentRequestSchema.parse(request.body),
      request.headers["idempotency-key"] as string | undefined
    );
    return reply.code(result.status).send(result.body);
  });
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
