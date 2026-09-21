import type { FastifyInstance } from "fastify";
import { getHealth } from "../services/health-service.js";

export async function healthRoutes(
  app: FastifyInstance,
  options: { checkDatabase?: () => Promise<void> }
) {
  app.get("/health", () => getHealth());
  app.get("/ready", async (_request, reply) => {
    try {
      if (!options.checkDatabase) throw new Error("Database check unavailable");
      await options.checkDatabase();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
}
