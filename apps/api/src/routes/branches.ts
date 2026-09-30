import {
  agentBranchParamsSchema,
  branchListQuerySchema,
  branchOnboardingRequestSchema,
  createBranchRequestSchema,
  projectBranchParamsSchema,
  projectTaskParamsSchema,
  registerBranchRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { BranchService } from "../services/branch-service.js";

// Branch routes (docs/project-branches.md §6.7). Humans manage branches in a
// project; agents list, look up and register them for their credential's
// project. Only owners and admins set the default or archive.
export async function humanBranchRoutes(
  app: FastifyInstance,
  options: { branches: BranchService }
) {
  app.get("/projects/:projectId/branches", (request) =>
    options.branches.list(
      request.userId,
      projectTaskParamsSchema.parse(request.params).projectId,
      branchListQuerySchema.parse(request.query)
    )
  );
  app.post("/projects/:projectId/branches", async (request, reply) =>
    reply
      .code(201)
      .send(
        await options.branches.create(
          request.userId,
          projectTaskParamsSchema.parse(request.params).projectId,
          createBranchRequestSchema.parse(request.body)
        )
      )
  );
  app.get("/projects/:projectId/branches/:branchId", (request) => {
    const params = projectBranchParamsSchema.parse(request.params);
    return options.branches.get(
      request.userId,
      params.projectId,
      params.branchId
    );
  });
  app.post(
    "/projects/:projectId/branches/:branchId/default",
    async (request) => {
      const params = projectBranchParamsSchema.parse(request.params);
      return {
        branch: await options.branches.setDefault(
          request.userId,
          params.projectId,
          params.branchId
        )
      };
    }
  );
  app.post(
    "/projects/:projectId/branches/:branchId/archive",
    async (request) => {
      const params = projectBranchParamsSchema.parse(request.params);
      return {
        branch: await options.branches.archive(
          request.userId,
          params.projectId,
          params.branchId
        )
      };
    }
  );
  app.post(
    "/projects/:projectId/branches/:branchId/onboarding",
    async (request) => {
      const params = projectBranchParamsSchema.parse(request.params);
      return {
        branch: await options.branches.completeOnboarding(
          request.userId,
          params.projectId,
          params.branchId,
          branchOnboardingRequestSchema.parse(request.body)
        )
      };
    }
  );
}

export async function agentBranchRoutes(
  app: FastifyInstance,
  options: { branches: BranchService }
) {
  app.get("/branches", (request) =>
    options.branches.listForAgent(
      request.agentPrincipal!,
      branchListQuerySchema.parse(request.query)
    )
  );
  app.get("/branches/:branchId", (request) =>
    options.branches.getForAgent(
      request.agentPrincipal!,
      agentBranchParamsSchema.parse(request.params).branchId
    )
  );
  app.post("/branches/register", (request) =>
    options.branches.registerForAgent(
      request.agentPrincipal!,
      registerBranchRequestSchema.parse(request.body)
    )
  );
}
