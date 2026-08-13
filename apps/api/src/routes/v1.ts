import {
  createOrganizationRequestSchema,
  createProjectRequestSchema,
  createWorkspaceRequestSchema,
  idParamsSchema,
  organizationParamsSchema,
  updateProjectRequestSchema,
  workspaceParamsSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { ProjectService } from "../services/project-service.js";

export async function v1Routes(
  app: FastifyInstance,
  options: { projects: ProjectService }
) {
  app.get("/organizations", (request) =>
    options.projects.listOrganizations(request.userId)
  );

  app.post("/organizations", async (request, reply) => {
    const result = await options.projects.createOrganization(
      request.userId,
      createOrganizationRequestSchema.parse(request.body)
    );
    return reply.code(201).send(result);
  });

  app.get("/organizations/:id", (request) =>
    options.projects.getOrganization(
      request.userId,
      idParamsSchema.parse(request.params).id
    )
  );

  app.get("/organizations/:organizationId/workspaces", (request) =>
    options.projects.listWorkspaces(
      request.userId,
      organizationParamsSchema.parse(request.params).organizationId
    )
  );

  app.post(
    "/organizations/:organizationId/workspaces",
    async (request, reply) => {
      const result = await options.projects.createWorkspace(
        request.userId,
        organizationParamsSchema.parse(request.params).organizationId,
        createWorkspaceRequestSchema.parse(request.body)
      );
      return reply.code(201).send(result);
    }
  );

  app.get("/workspaces/:id", (request) =>
    options.projects.getWorkspace(
      request.userId,
      idParamsSchema.parse(request.params).id
    )
  );

  app.get("/workspaces/:workspaceId/projects", (request) =>
    options.projects.listProjects(
      request.userId,
      workspaceParamsSchema.parse(request.params).workspaceId
    )
  );

  app.post("/workspaces/:workspaceId/projects", async (request, reply) => {
    const result = await options.projects.createProject(
      request.userId,
      workspaceParamsSchema.parse(request.params).workspaceId,
      createProjectRequestSchema.parse(request.body)
    );
    return reply.code(201).send(result);
  });

  app.get("/projects/:id", (request) =>
    options.projects.getProject(
      request.userId,
      idParamsSchema.parse(request.params).id
    )
  );

  app.patch("/projects/:id", (request) =>
    options.projects.updateProject(
      request.userId,
      idParamsSchema.parse(request.params).id,
      updateProjectRequestSchema.parse(request.body)
    )
  );

  app.post("/projects/:id/archive", (request) =>
    options.projects.archiveProject(
      request.userId,
      idParamsSchema.parse(request.params).id
    )
  );
}
