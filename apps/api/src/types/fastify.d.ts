import "fastify";
import type { AgentPrincipal } from "../services/agent-service.js";

declare module "fastify" {
  interface FastifyRequest {
    agentPrincipal: AgentPrincipal | null;
    suggestedUsername: string | null;
    userId: string;
  }
}
