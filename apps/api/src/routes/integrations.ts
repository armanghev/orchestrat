import {
  connectOrganizationRepositoryRequestSchema,
  createIntegrationAuthorizationRequestSchema,
  createOrganizationIntegrationRequestSchema,
  importRepositoryProjectRequestSchema,
  integrationAuthorizationParamsSchema,
  integrationParamsSchema,
  organizationParamsSchema,
  organizationRepositoriesQuerySchema,
  organizationRepositoryParamsSchema,
  projectTaskParamsSchema,
  updateOrganizationIntegrationRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { IntegrationService } from "../services/repository/integration-service.js";
import type { ProjectService } from "../services/project-service.js";

// Organization Git integrations and importing their repositories as
// projects. Owners and admins only; the service checks every call.
export async function integrationRoutes(
  app: FastifyInstance,
  options: { integrations: IntegrationService; projects: ProjectService }
) {
  const { integrations, projects } = options;
  const organization = (params: unknown) =>
    organizationParamsSchema.parse(params).organizationId;

  app.get("/organizations/:organizationId/integrations", (request) =>
    integrations.list(request.userId, organization(request.params))
  );
  app.post(
    "/organizations/:organizationId/integrations/authorizations",
    (request) =>
      integrations.authorize(
        request.userId,
        organization(request.params),
        createIntegrationAuthorizationRequestSchema.parse(request.body)
      )
  );
  app.get(
    "/organizations/:organizationId/integrations/authorizations/:authorizationId",
    (request) => {
      const params = integrationAuthorizationParamsSchema.parse(request.params);
      return integrations.authorizationOptions(
        request.userId,
        params.organizationId,
        params.authorizationId
      );
    }
  );
  app.post(
    "/organizations/:organizationId/integrations",
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await integrations.create(
            request.userId,
            organization(request.params),
            createOrganizationIntegrationRequestSchema.parse(request.body)
          )
        )
  );
  app.patch(
    "/organizations/:organizationId/integrations/:integrationId",
    (request) => {
      const params = integrationParamsSchema.parse(request.params);
      return integrations.update(
        request.userId,
        params.organizationId,
        params.integrationId,
        updateOrganizationIntegrationRequestSchema.parse(request.body)
      );
    }
  );
  app.delete(
    "/organizations/:organizationId/integrations/:integrationId",
    async (request, reply) => {
      const params = integrationParamsSchema.parse(request.params);
      await integrations.remove(
        request.userId,
        params.organizationId,
        params.integrationId
      );
      return reply.code(204).send();
    }
  );
  app.post(
    "/organizations/:organizationId/integrations/:integrationId/refresh",
    (request) => {
      const params = integrationParamsSchema.parse(request.params);
      return integrations.refreshNow(
        request.userId,
        params.organizationId,
        params.integrationId
      );
    }
  );

  app.get("/organizations/:organizationId/repositories", (request) =>
    integrations.listRepositories(
      request.userId,
      organization(request.params),
      organizationRepositoriesQuerySchema.parse(request.query).filter
    )
  );
  app.post(
    "/organizations/:organizationId/repositories/:repositoryId/dismiss",
    (request) => {
      const params = organizationRepositoryParamsSchema.parse(request.params);
      return integrations.dismiss(
        request.userId,
        params.organizationId,
        params.repositoryId
      );
    }
  );

  // Import: a new project already connected to the repository. A failed
  // connection removes the project it just created.
  app.post(
    "/organizations/:organizationId/projects/import",
    async (request, reply) => {
      const organizationId = organization(request.params);
      const input = importRepositoryProjectRequestSchema.parse(request.body);
      // Check before creating anything.
      await integrations.listRepositories(
        request.userId,
        organizationId,
        "all"
      );
      const project = await projects.createProject(
        request.userId,
        organizationId,
        {
          name: input.name,
          description: input.description ?? null,
          task_key_prefix: input.task_key_prefix
        }
      );
      try {
        const { repository } = await integrations.connectProject(
          request.userId,
          project.id,
          input.repository_id
        );
        return reply.code(201).send({ project, repository });
      } catch (error) {
        await integrations.discardProject(project.id).catch(() => undefined);
        throw error;
      }
    }
  );
  app.post("/projects/:projectId/repository/import", async (request, reply) =>
    reply
      .code(201)
      .send(
        await integrations.connectProject(
          request.userId,
          projectTaskParamsSchema.parse(request.params).projectId,
          connectOrganizationRepositoryRequestSchema.parse(request.body)
            .repository_id
        )
      )
  );
}
