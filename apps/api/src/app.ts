import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";

export function buildApp() {
  const app = Fastify({ logger: false });
  app.register(healthRoutes);
  return app;
}
