import {
  createOrganizationRequestSchema,
  createProjectRequestSchema,
  deleteResourceRequestSchema,
  idParamsSchema,
  organizationParamsSchema,
  projectLifecycleRequestSchema,
  updateOrganizationMemberRequestSchema,
  updateOrganizationRequestSchema,
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

  app.delete("/profile/avatar", (request) =>
    options.profiles.removeAvatar(request.userId)
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

  app.patch("/organizations/:id", (request) =>
    options.projects.updateOrganization(
      request.userId,
      idParamsSchema.parse(request.params).id,
      updateOrganizationRequestSchema.parse(request.body)
    )
  );

  app.delete("/organizations/:id", (request) =>
    options.projects.deleteOrganization(
      request.userId,
      idParamsSchema.parse(request.params).id,
      deleteResourceRequestSchema.parse(request.body).name
    )
  );

  app.get("/organizations/:organizationId/members", (request) =>
    options.projects.listMembers(
      request.userId,
      organizationParamsSchema.parse(request.params).organizationId
    )
  );

  app.patch("/organizations/:organizationId/members/:memberId", (request) => {
    const params = organizationParamsSchema
      .extend({ memberId: idParamsSchema.shape.id })
      .parse(request.params);
    return options.projects.updateMember(
      request.userId,
      params.organizationId,
      params.memberId,
      updateOrganizationMemberRequestSchema.parse(request.body)
    );
  });

  app.delete("/organizations/:organizationId/members/:memberId", (request) => {
    const params = organizationParamsSchema
      .extend({ memberId: idParamsSchema.shape.id })
      .parse(request.params);
    return options.projects.removeMember(
      request.userId,
      params.organizationId,
      params.memberId
    );
  });

  app.post("/organizations/:organizationId/members/leave", (request) =>
    options.projects.leaveOrganization(
      request.userId,
      organizationParamsSchema.parse(request.params).organizationId
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

  app.post("/projects/:id/reactivate", (request) =>
    options.projects.reactivateProject(
      request.userId,
      idParamsSchema.parse(request.params).id
    )
  );

  app.delete("/projects/:id", (request) =>
    options.projects.deleteProject(
      request.userId,
      idParamsSchema.parse(request.params).id,
      projectLifecycleRequestSchema.parse(request.body).name
    )
  );
}
