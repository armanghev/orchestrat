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
import { ApiError } from "../services/api-error.js";
import type { BranchService } from "../services/branch-service.js";
import { FixedWindowRateLimit } from "../services/rate-limit.js";

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
  options: { branches: BranchService; registrationsPerMinute?: number }
) {
  // At most 10 new branches per minute per agent credential (spec §12).
  // Registering a branch that already exists is free: the CLI does it on
  // every session start.
  const creations = new FixedWindowRateLimit(
    options.registrationsPerMinute ?? 10,
    60_000
  );
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
  app.post("/branches/register", async (request, reply) => {
    const principal = request.agentPrincipal!;
    try {
      return await options.branches.registerForAgent(
        principal,
        registerBranchRequestSchema.parse(request.body),
        () => {
          const retryAfter = creations.check(principal.credentialId);
          if (retryAfter !== null)
            throw new ApiError(
              429,
              "RATE_LIMITED",
              "Too many new branches. Try again shortly.",
              { retry_after_seconds: retryAfter }
            );
        }
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === "RATE_LIMITED")
        reply.header(
          "retry-after",
          String(error.details?.retry_after_seconds ?? 60)
        );
      throw error;
    }
  });
}
