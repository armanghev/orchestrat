import type { FastifyInstance } from "fastify";
import { getHealth } from "../services/health-service.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", () => getHealth());
}
