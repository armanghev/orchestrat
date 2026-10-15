import { createHash, randomBytes } from "node:crypto";
import {
  organizationMembers,
  organizations,
  projectInvitations,
  projectMembers,
  projects,
  users,
  type Database
} from "@orchestrat/db";
import type {
  AddProjectMemberRequest,
  CreateProjectInvitationResponse,
  Project,
  ProjectInvitation,
  ProjectMember,
  UpdateProjectMemberRequest
} from "@orchestrat/protocol";
import { and, asc, count, eq } from "drizzle-orm";
import { ApiError } from "./api-error.js";
import { PermissionService } from "./permission-service.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type AssertProjectMemberRemovable = (
  tx: Transaction,
  projectId: string,
  userId: string
) => Promise<void>;

const invitationTtlMs = 7 * 24 * 60 * 60_000;
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const projectJson = (
  project: typeof projects.$inferSelect,
  role: Project["role"]
): Project => ({
  role,
  id: project.id,
  organization_id: project.organizationId,
  name: project.name,
  slug: project.slug,
  description: project.description,
  status: project.status,
  created_at: project.createdAt.toISOString(),
  updated_at: project.updatedAt.toISOString(),
  archived_at: project.archivedAt?.toISOString() ?? null
});

const memberJson = (row: {
  user: typeof users.$inferSelect;
  membership: typeof projectMembers.$inferSelect;
}): ProjectMember => ({
  user_id: row.user.id,
  username: row.user.username,
  full_name: row.user.name,
  email: row.user.email,
  avatar_url: row.user.avatarUrl,
  role: row.membership.role,
  created_at: row.membership.createdAt.toISOString()
});

const invitationJson = (
  invitation: typeof projectInvitations.$inferSelect
): ProjectInvitation => ({
  id: invitation.id,
  project_id: invitation.projectId,
  created_by: invitation.createdBy,
  created_at: invitation.createdAt.toISOString(),
  expires_at: invitation.expiresAt.toISOString(),
  revoked_at: invitation.revokedAt?.toISOString() ?? null,
  accepted_at: invitation.acceptedAt?.toISOString() ?? null
});

export class ProjectMembershipService {
  private readonly permissions: PermissionService;

  constructor(
    private readonly db: Database,
    private readonly assertProjectMemberRemovable: AssertProjectMemberRemovable,
    private readonly now: () => Date = () => new Date()
  ) {
    this.permissions = new PermissionService(db);
  }

  async listMembers(userId: string, projectId: string) {
    await this.permissions.projectAccess(userId, projectId);
    const rows = await this.db
      .select({ user: users, membership: projectMembers })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, projectId))
      .orderBy(asc(users.name));
    return { members: rows.map(memberJson) };
  }

  async addMember(
    userId: string,
    projectId: string,
    input: AddProjectMemberRequest
  ) {
    return this.db.transaction(async (tx) => {
      const context = await this.editorContext(tx, userId, projectId, true);
      const [organizationMember] = await tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(
          and(
            eq(
              organizationMembers.organizationId,
              context.project.organizationId
            ),
            eq(organizationMembers.userId, input.user_id)
          )
        )
        .limit(1);
      if (!organizationMember)
        throw new ApiError(404, "NOT_FOUND", "Organization member not found.");
      this.assertAssignable(context.role, input.role ?? "member");
      const [existing] = await tx
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, input.user_id)
          )
        )
        .limit(1);
      if (existing)
        throw new ApiError(
          409,
          "CONFLICT",
          "User is already a project member."
        );
      const [membership] = await tx
        .insert(projectMembers)
        .values({
          projectId,
          userId: input.user_id,
          role: input.role ?? "member"
        })
        .returning();
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, input.user_id))
        .limit(1);
      if (!user) throw new ApiError(404, "NOT_FOUND", "User not found.");
      return memberJson({ user, membership });
    });
  }

  async updateMember(
    userId: string,
    projectId: string,
    memberId: string,
    input: UpdateProjectMemberRequest
  ) {
    return this.db.transaction(async (tx) => {
      const context = await this.editorContext(tx, userId, projectId, true);
      const [target] = await tx
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, memberId)
          )
        )
        .limit(1);
      if (!target)
        throw new ApiError(404, "NOT_FOUND", "Project member not found.");
      if (target.role === "owner" && context.role !== "owner")
        throw new ApiError(
          403,
          "PERMISSION_DENIED",
          "Admins cannot modify owners."
        );
      this.assertAssignable(context.role, input.role);
      if (target.role === "owner" && input.role !== "owner")
        await this.assertAnotherOwner(tx, projectId);
      const [membership] = await tx
        .update(projectMembers)
        .set({ role: input.role })
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, memberId)
          )
        )
        .returning();
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, memberId))
        .limit(1);
      if (!user) throw new ApiError(404, "NOT_FOUND", "User not found.");
      return memberJson({ user, membership });
    });
  }

  async removeMember(userId: string, projectId: string, memberId: string) {
    await this.permissions.projectEditor(userId, projectId);
    return this.db.transaction(async (tx) => {
      const context = await this.editorContext(tx, userId, projectId, false);
      const [target] = await tx
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, memberId)
          )
        )
        .limit(1);
      if (!target)
        throw new ApiError(404, "NOT_FOUND", "Project member not found.");
      if (target.role === "owner" && context.role !== "owner")
        throw new ApiError(
          403,
          "PERMISSION_DENIED",
          "Admins cannot remove owners."
        );
      if (target.role === "owner") await this.assertAnotherOwner(tx, projectId);
      await this.assertProjectMemberRemovable(tx, projectId, memberId);
      await tx
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, memberId)
          )
        );
      return { deleted: true as const };
    });
  }

  async listInvitations(userId: string, projectId: string) {
    await this.permissions.projectEditor(userId, projectId);
    const invitations = await this.db
      .select()
      .from(projectInvitations)
      .where(eq(projectInvitations.projectId, projectId))
      .orderBy(asc(projectInvitations.createdAt));
    return { invitations: invitations.map(invitationJson) };
  }

  async createInvitation(
    userId: string,
    projectId: string
  ): Promise<CreateProjectInvitationResponse> {
    return this.db.transaction(async (tx) => {
      await this.editorContext(tx, userId, projectId, true);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(this.now().getTime() + invitationTtlMs);
      const [invitation] = await tx
        .insert(projectInvitations)
        .values({
          projectId,
          createdBy: userId,
          tokenHash: tokenHash(token),
          expiresAt
        })
        .returning();
      return { invitation: invitationJson(invitation), token };
    });
  }

  async revokeInvitation(
    userId: string,
    projectId: string,
    invitationId: string
  ) {
    return this.db.transaction(async (tx) => {
      await this.editorContext(tx, userId, projectId, false);
      const [invitation] = await tx
        .select()
        .from(projectInvitations)
        .where(
          and(
            eq(projectInvitations.id, invitationId),
            eq(projectInvitations.projectId, projectId)
          )
        )
        .for("update");
      if (!invitation)
        throw new ApiError(404, "NOT_FOUND", "Project invitation not found.");
      if (invitation.acceptedAt)
        throw new ApiError(
          409,
          "CONFLICT",
          "Accepted invitations cannot be revoked."
        );
      if (!invitation.revokedAt) {
        const now = this.now();
        await tx
          .update(projectInvitations)
          .set({ revokedAt: now })
          .where(eq(projectInvitations.id, invitation.id));
        invitation.revokedAt = now;
      }
      return { invitation: invitationJson(invitation) };
    });
  }

  async acceptInvitation(userId: string, token: string) {
    return this.db.transaction((tx) =>
      this.acceptInvitationIn(tx, userId, token)
    );
  }

  // Sign-up accepts an invite inside its own transaction.
  async acceptInvitationIn(tx: Transaction, userId: string, token: string) {
    const hash = tokenHash(token);
    {
      const [candidate] = await tx
        .select({
          id: projectInvitations.id,
          projectId: projectInvitations.projectId
        })
        .from(projectInvitations)
        .where(eq(projectInvitations.tokenHash, hash))
        .limit(1);
      if (!candidate)
        throw new ApiError(404, "NOT_FOUND", "Project invitation not found.");
      const project = await this.lockProject(tx, candidate.projectId);
      const [invitation] = await tx
        .select()
        .from(projectInvitations)
        .where(
          and(
            eq(projectInvitations.id, candidate.id),
            eq(projectInvitations.tokenHash, hash)
          )
        )
        .for("update");
      if (!invitation)
        throw new ApiError(404, "NOT_FOUND", "Project invitation not found.");
      if (invitation.acceptedAt) {
        if (invitation.acceptedBy !== userId)
          throw new ApiError(
            409,
            "CONFLICT",
            "Project invitation was already accepted."
          );
        const role = await this.currentRole(tx, project, userId);
        if (!role)
          throw new ApiError(
            403,
            "PERMISSION_DENIED",
            "You no longer have access to this project."
          );
        return { project: projectJson(project, role) };
      }
      if (invitation.revokedAt || invitation.expiresAt <= this.now())
        throw new ApiError(
          409,
          "CONFLICT",
          "Project invitation is no longer valid."
        );
      if (project.status === "archived")
        throw new ApiError(
          409,
          "PROJECT_ARCHIVED",
          "Archived projects cannot accept invitations."
        );
      if (!(await this.inviterCanEdit(tx, project, invitation.createdBy)))
        throw new ApiError(
          409,
          "CONFLICT",
          "Project invitation is no longer valid."
        );
      await tx
        .insert(organizationMembers)
        .values({
          organizationId: project.organizationId,
          userId,
          role: "member"
        })
        .onConflictDoNothing();
      await tx
        .insert(projectMembers)
        .values({ projectId: project.id, userId, role: "member" })
        .onConflictDoNothing();
      const role = await this.currentRole(tx, project, userId);
      if (!role)
        throw new ApiError(
          409,
          "CONFLICT",
          "Project invitation could not be accepted."
        );
      const acceptedAt = this.now();
      await tx
        .update(projectInvitations)
        .set({ acceptedAt, acceptedBy: userId })
        .where(eq(projectInvitations.id, invitation.id));
      return { project: projectJson(project, role) };
    }
  }

  private async editorContext(
    tx: Transaction,
    userId: string,
    projectId: string,
    active: boolean
  ) {
    const project = await this.lockProject(tx, projectId);
    const role = await this.currentRole(tx, project, userId);
    if (!role)
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "You do not have access to this project."
      );
    if (role === "member")
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "Only project owners and admins can edit this project."
      );
    if (active && project.status === "archived")
      throw new ApiError(
        409,
        "PROJECT_ARCHIVED",
        "Archived projects are read-only."
      );
    return { project, role };
  }

  private async lockProject(tx: Transaction, projectId: string) {
    const [candidate] = await tx
      .select({ organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!candidate) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, candidate.organizationId))
      .for("update");
    if (!organization)
      throw new ApiError(404, "NOT_FOUND", "Organization not found.");
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update");
    if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    return project;
  }

  private async currentRole(
    tx: Transaction,
    project: typeof projects.$inferSelect,
    userId: string
  ) {
    const [membership] = await tx
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.userId, projectMembers.userId),
          eq(organizationMembers.organizationId, project.organizationId)
        )
      )
      .where(
        and(
          eq(projectMembers.projectId, project.id),
          eq(projectMembers.userId, userId)
        )
      )
      .limit(1);
    return membership?.role;
  }

  private async assertAnotherOwner(tx: Transaction, projectId: string) {
    const [{ ownerCount }] = await tx
      .select({ ownerCount: count() })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.role, "owner")
        )
      );
    if (Number(ownerCount) <= 1)
      throw new ApiError(
        409,
        "CONFLICT",
        "The sole project owner cannot leave or lose ownership."
      );
  }

  private assertAssignable(
    actorRole: "owner" | "admin" | "member",
    role: "owner" | "admin" | "member"
  ) {
    if (role === "owner" && actorRole !== "owner")
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "Only project owners can assign owner role."
      );
  }

  private async inviterCanEdit(
    tx: Transaction,
    project: typeof projects.$inferSelect,
    userId: string
  ) {
    const role = await this.currentRole(tx, project, userId);
    return role === "owner" || role === "admin";
  }
}
