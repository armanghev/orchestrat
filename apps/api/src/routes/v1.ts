import {
  createOrganizationRequestSchema,
  createProjectRequestSchema,
  idParamsSchema,
  organizationParamsSchema,
  updateProjectRequestSchema,
  updateProfileRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { ProjectService } from "../services/project-service.js";
import type { ProfileService } from "../services/profile-service.js";

export async function v1Routes(
  app: FastifyInstance,
  options: { projects: ProjectService; profiles: ProfileService }
) {
  app.get("/profile", (request) => options.profiles.get(request.userId));

  app.patch("/profile", (request) =>
    options.profiles.update(
      request.userId,
      updateProfileRequestSchema.parse(request.body)
    )
  );

  app.post("/profile/avatar", async (request) => {
    const file = await request.file();
    if (!file) throw new Error("An avatar image is required.");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype))
      throw new Error("Avatars must be JPEG, PNG, or WebP images.");
    return options.profiles.updateAvatar(request.userId, {
      mimetype: file.mimetype,
      buffer: await file.toBuffer()
    });
  });

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

  app.get("/organizations/:organizationId/projects", (request) =>
    options.projects.listProjects(
      request.userId,
      organizationParamsSchema.parse(request.params).organizationId
    )
  );

  app.post(
    "/organizations/:organizationId/projects",
    async (request, reply) => {
      const result = await options.projects.createProject(
        request.userId,
        organizationParamsSchema.parse(request.params).organizationId,
        createProjectRequestSchema.parse(request.body)
      );
      return reply.code(201).send(result);
    }
  );

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
