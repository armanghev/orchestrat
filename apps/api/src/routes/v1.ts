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
  updateProfileRequestSchema,
  createTaskRequestSchema,
  taskListQuerySchema,
  taskIdParamsSchema,
  projectTaskParamsSchema,
  updateTaskRequestSchema,
  moveTaskRequestSchema,
  taskCommentsQuerySchema,
  createTaskCommentRequestSchema,
  createTaskDependencyRequestSchema,
  deleteTaskDependencyParamsSchema,
  deleteTaskDependencyRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { humanBranchSelector } from "../services/branch-context.js";
import type { ProjectService } from "../services/project-service.js";
import type { ProfileService } from "../services/profile-service.js";
import type { TaskService } from "../services/task-service.js";

export async function v1Routes(
  app: FastifyInstance,
  options: {
    projects: ProjectService;
    profiles: ProfileService;
    tasks: TaskService;
    expensiveRateLimit: preHandlerHookHandler;
  }
) {
  app.get("/profile", async (request) => ({
    ...(await options.profiles.get(request.userId)),
    suggested_username: request.suggestedUsername
  }));

  app.patch("/profile", (request) =>
    options.profiles.update(
      request.userId,
      updateProfileRequestSchema.parse(request.body)
    )
  );

  app.delete("/profile/avatar", (request) =>
    options.profiles.removeAvatar(request.userId)
  );

  app.post(
    "/profile/avatar",
    { preHandler: options.expensiveRateLimit },
    async (request) => {
      const file = await request.file();
      if (!file) throw new Error("An avatar image is required.");
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype))
        throw new Error("Avatars must be JPEG, PNG, or WebP images.");
      return options.profiles.updateAvatar(request.userId, {
        mimetype: file.mimetype,
        buffer: await file.toBuffer()
      });
    }
  );

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

  app.get("/organizations/:organizationId/project-summaries", (request) =>
    options.projects.listProjectSummaries(
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

  app.post("/projects/:projectId/tasks", async (request, reply) => {
    const result = await options.tasks.create(
      request.userId,
      projectTaskParamsSchema.parse(request.params).projectId,
      createTaskRequestSchema.parse(request.body),
      request.headers["idempotency-key"] as string | undefined,
      humanBranchSelector(request.query)
    );
    return reply.code(result.status).send(result.body);
  });
  app.get("/projects/:projectId/tasks", (request) =>
    options.tasks.list(
      request.userId,
      projectTaskParamsSchema.parse(request.params).projectId,
      taskListQuerySchema.parse(request.query),
      humanBranchSelector(request.query)
    )
  );
  app.get("/tasks/:id", (request) =>
    options.tasks.get(
      request.userId,
      taskIdParamsSchema.parse(request.params).id
    )
  );
  app.patch("/tasks/:id", (request) =>
    options.tasks.update(
      request.userId,
      taskIdParamsSchema.parse(request.params).id,
      updateTaskRequestSchema.parse(request.body)
    )
  );
  app.post("/tasks/:id/move", (request) =>
    options.tasks.move(
      request.userId,
      taskIdParamsSchema.parse(request.params).id,
      moveTaskRequestSchema.parse(request.body)
    )
  );
  app.get("/tasks/:id/comments", (request) => {
    const query = taskCommentsQuerySchema.parse(request.query);
    return options.tasks.comments(
      request.userId,
      taskIdParamsSchema.parse(request.params).id,
      query.limit,
      query.cursor
    );
  });
  app.post("/tasks/:id/comments", async (request, reply) => {
    const result = await options.tasks.createComment(
      request.userId,
      taskIdParamsSchema.parse(request.params).id,
      createTaskCommentRequestSchema.parse(request.body),
      request.headers["idempotency-key"] as string | undefined
    );
    return reply.code(result.status).send(result.body);
  });
  app.get("/tasks/:id/dependencies", (request) =>
    options.tasks.dependencies(
      request.userId,
      taskIdParamsSchema.parse(request.params).id
    )
  );
  app.post("/tasks/:id/dependencies", (request) =>
    options.tasks.addDependency(
      request.userId,
      taskIdParamsSchema.parse(request.params).id,
      createTaskDependencyRequestSchema.parse(request.body)
    )
  );
  app.delete("/tasks/:id/dependencies/:dependsOnTaskId", (request) => {
    const params = deleteTaskDependencyParamsSchema.parse(request.params);
    const body = deleteTaskDependencyRequestSchema.parse(request.body);
    return options.tasks.removeDependency(
      request.userId,
      params.id,
      params.dependsOnTaskId,
      body.expected_version
    );
  });
}
