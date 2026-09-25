import {
  acceptProjectInvitationRequestSchema,
  addProjectMemberRequestSchema,
  idParamsSchema,
  updateProjectMemberRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { ProjectMembershipService } from "../services/project-membership-service.js";

const projectParamsSchema = idParamsSchema
  .extend({ projectId: idParamsSchema.shape.id })
  .omit({ id: true });
const projectMemberParamsSchema = projectParamsSchema.extend({
  userId: idParamsSchema.shape.id
});
const projectInvitationParamsSchema = projectParamsSchema.extend({
  invitationId: idParamsSchema.shape.id
});

export async function projectMemberRoutes(
  app: FastifyInstance,
  options: { memberships: ProjectMembershipService }
) {
  app.get("/projects/:projectId/members", (request) =>
    options.memberships.listMembers(
      request.userId,
      projectParamsSchema.parse(request.params).projectId
    )
  );

  app.post("/projects/:projectId/members", async (request, reply) => {
    const result = await options.memberships.addMember(
      request.userId,
      projectParamsSchema.parse(request.params).projectId,
      addProjectMemberRequestSchema.parse(request.body)
    );
    return reply.code(201).send(result);
  });

  app.patch("/projects/:projectId/members/:userId", (request) => {
    const params = projectMemberParamsSchema.parse(request.params);
    return options.memberships.updateMember(
      request.userId,
      params.projectId,
      params.userId,
      updateProjectMemberRequestSchema.parse(request.body)
    );
  });

  app.delete("/projects/:projectId/members/:userId", (request) => {
    const params = projectMemberParamsSchema.parse(request.params);
    return options.memberships.removeMember(
      request.userId,
      params.projectId,
      params.userId
    );
  });

  app.get("/projects/:projectId/invitations", (request) =>
    options.memberships.listInvitations(
      request.userId,
      projectParamsSchema.parse(request.params).projectId
    )
  );

  app.post("/projects/:projectId/invitations", async (request, reply) => {
    const result = await options.memberships.createInvitation(
      request.userId,
      projectParamsSchema.parse(request.params).projectId
    );
    return reply.code(201).send(result);
  });

  app.post(
    "/projects/:projectId/invitations/:invitationId/revoke",
    (request) => {
      const params = projectInvitationParamsSchema.parse(request.params);
      return options.memberships.revokeInvitation(
        request.userId,
        params.projectId,
        params.invitationId
      );
    }
  );

  app.post("/project-invitations/accept", (request) =>
    options.memberships.acceptInvitation(
      request.userId,
      acceptProjectInvitationRequestSchema.parse(request.body).token
    )
  );
}
