import {
  allBranchesQuerySchema,
  createAgentRequestSchema,
  idParamsSchema,
  paginationQuerySchema,
  projectTaskParamsSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import { humanBranchSelector } from "../services/branch-context.js";
import type { AgentService } from "../services/agent-service.js";

const projectAgentParamsSchema = projectTaskParamsSchema.extend({
  agentId: idParamsSchema.shape.id
});
const projectCredentialParamsSchema = projectTaskParamsSchema.extend({
  credentialId: idParamsSchema.shape.id
});

export async function agentManagementRoutes(
  app: FastifyInstance,
  options: { agents: AgentService }
) {
  app.post("/projects/:projectId/agents", async (request, reply) => {
    const params = projectTaskParamsSchema.parse(request.params);
    const result = await options.agents.createAgent(
      request.userId,
      params.projectId,
      createAgentRequestSchema.parse(request.body)
    );
    return reply.code(201).send(result);
  });
  app.get("/projects/:projectId/agents", (request) => {
    const params = projectTaskParamsSchema.parse(request.params);
    return options.agents.listAgents(request.userId, params.projectId);
  });
  app.post("/projects/:projectId/agents/:agentId/revoke", (request) => {
    const params = projectAgentParamsSchema.parse(request.params);
    return options.agents.revokeAgent(
      request.userId,
      params.projectId,
      params.agentId
    );
  });
  app.post(
    "/projects/:projectId/agents/:agentId/credentials",
    async (request, reply) => {
      const params = projectAgentParamsSchema.parse(request.params);
      return reply
        .code(201)
        .send(
          await options.agents.issueCredential(
            request.userId,
            params.projectId,
            params.agentId
          )
        );
    }
  );
  app.get("/projects/:projectId/credentials", (request) => {
    const params = projectTaskParamsSchema.parse(request.params);
    return options.agents.listCredentials(request.userId, params.projectId);
  });
  app.post(
    "/projects/:projectId/credentials/:credentialId/revoke",
    (request) => {
      const params = projectCredentialParamsSchema.parse(request.params);
      return options.agents.revokeCredential(
        request.userId,
        params.projectId,
        params.credentialId
      );
    }
  );
  app.get("/projects/:projectId/presence", (request) => {
    const params = projectTaskParamsSchema.parse(request.params);
    return options.agents.presence(request.userId, params.projectId);
  });
  app.get("/projects/:projectId/events", (request) => {
    const params = projectTaskParamsSchema.parse(request.params);
    return options.agents.listEventsHuman(
      request.userId,
      params.projectId,
      paginationQuerySchema.parse(request.query),
      humanBranchSelector(request.query),
      allBranchesQuerySchema.parse(request.query).all_branches
    );
  });
}
