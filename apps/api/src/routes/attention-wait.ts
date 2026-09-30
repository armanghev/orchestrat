import { projectTaskParamsSchema, waitQuerySchema } from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { AttentionRouteOptions } from "./attention.js";

export async function agentWaitRoutes(
  app: FastifyInstance,
  options: AttentionRouteOptions
) {
  // Long polls end with their current result before the server closes.
  app.addHook("preClose", async () => options.waits.close());
  app.get("/attention/wait", async (request) => {
    const query = waitQuerySchema.parse(request.query);
    // A client disconnect aborts the wait and frees its slot at once.
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once("close", abort);
    if (request.raw.destroyed) abort();
    try {
      return await options.waits.wait(
        request.agentPrincipal!,
        query,
        controller.signal
      );
    } finally {
      request.raw.off("close", abort);
    }
  });
}

export async function humanWaitRoutes(
  app: FastifyInstance,
  options: AttentionRouteOptions
) {
  app.get("/projects/:projectId/attention/agents", (request) => {
    const { projectId } = projectTaskParamsSchema.parse(request.params);
    return options.attention.agentAttentionHuman(
      request.userId,
      projectId,
      options.waits.waitingSince(projectId)
    );
  });
}
