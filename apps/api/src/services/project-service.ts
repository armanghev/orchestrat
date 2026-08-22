import { randomUUID } from "node:crypto";
import {
  organizationMembers,
  organizations,
  projects,
  users,
  type Database
} from "@orchestrat/db";
import type {
  CreateOrganizationRequest,
  CreateProjectRequest,
  DeleteResourceResponse,
  Organization,
  OrganizationMember,
  Project,
  UpdateOrganizationMemberRequest,
  UpdateOrganizationRequest,
  UpdateProjectRequest
} from "@orchestrat/protocol";
import { and, asc, count, eq } from "drizzle-orm";
import { ApiError } from "./api-error.js";
import { PermissionService } from "./permission-service.js";

const slugify = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/g, "") || `item-${randomUUID().slice(0, 8)}`;

const organizationJson = (
  organization: typeof organizations.$inferSelect,
  role: Organization["role"]
): Organization => ({
  id: organization.id,
  name: organization.name,
  slug: organization.slug,
  role,
  created_at: organization.createdAt.toISOString(),
  updated_at: organization.updatedAt.toISOString()
});

const projectJson = (project: typeof projects.$inferSelect): Project => ({
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

const memberJson = (member: {
  user: typeof users.$inferSelect;
  membership: typeof organizationMembers.$inferSelect;
}): OrganizationMember => ({
  user_id: member.user.id,
  username: member.user.username,
  full_name: member.user.name,
  email: member.user.email,
  avatar_url: member.user.avatarUrl,
  role: member.membership.role,
  created_at: member.membership.createdAt.toISOString()
});

export class ProjectService {
  private readonly permissions: PermissionService;

  constructor(private readonly db: Database) {
    this.permissions = new PermissionService(db);
  }

  async listOrganizations(userId: string) {
    const rows = await this.db
      .select({ organization: organizations, role: organizationMembers.role })
      .from(organizationMembers)
      .innerJoin(
        organizations,
        eq(organizations.id, organizationMembers.organizationId)
      )
      .where(eq(organizationMembers.userId, userId))
      .orderBy(asc(organizations.name));
    return {
      organizations: rows.map((row) =>
        organizationJson(row.organization, row.role)
      )
    };
  }

  async createOrganization(userId: string, input: CreateOrganizationRequest) {
    return this.db.transaction(async (tx) => {
      const [organization] = await tx
        .insert(organizations)
        .values({
          id: randomUUID(),
          name: input.name,
          slug: input.slug ?? slugify(input.name)
        })
        .returning();
      await tx.insert(organizationMembers).values({
        organizationId: organization.id,
        userId,
        role: "owner"
      });
      return organizationJson(organization, "owner");
    });
  }

  async getOrganization(userId: string, organizationId: string) {
    const record = await this.permissions.organization(userId, organizationId);
    return organizationJson(record.organization, record.role);
  }

  async updateOrganization(
    userId: string,
    organizationId: string,
    input: UpdateOrganizationRequest
  ) {
    await this.permissions.organizationEditor(userId, organizationId);
    const [organization] = await this.db
      .update(organizations)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(organizations.id, organizationId))
      .returning();
    if (!organization)
      throw new ApiError(404, "NOT_FOUND", "Organization not found.");
    const membership = await this.permissions.organization(
      userId,
      organizationId
    );
    return organizationJson(organization, membership.role);
  }

  async deleteOrganization(
    userId: string,
    organizationId: string,
    name: string
  ): Promise<DeleteResourceResponse> {
    const current = await this.permissions.organizationOwner(
      userId,
      organizationId
    );
    if (current.organization.name !== name)
      throw new ApiError(
        409,
        "CONFLICT",
        "The organization name does not match."
      );
    const [deleted] = await this.db
      .delete(organizations)
      .where(
        and(eq(organizations.id, organizationId), eq(organizations.name, name))
      )
      .returning({ id: organizations.id });
    if (!deleted)
      throw new ApiError(404, "NOT_FOUND", "Organization not found.");
    return { deleted: true };
  }

  async listMembers(userId: string, organizationId: string) {
    await this.permissions.organization(userId, organizationId);
    const rows = await this.db
      .select({ user: users, membership: organizationMembers })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, organizationId))
      .orderBy(asc(users.name));
    return { members: rows.map(memberJson) };
  }

  async updateMember(
    userId: string,
    organizationId: string,
    memberId: string,
    input: UpdateOrganizationMemberRequest
  ) {
    const actor = await this.permissions.organizationEditor(
      userId,
      organizationId
    );
    const [target] = await this.db
      .select({ membership: organizationMembers })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, memberId)
        )
      )
      .limit(1);
    if (!target)
      throw new ApiError(404, "NOT_FOUND", "Organization member not found.");
    if (target.membership.role === "owner" && actor.role !== "owner")
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "Admins cannot modify owners."
      );
    if (input.role === "owner" && actor.role !== "owner")
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "Admins cannot assign owner role."
      );
    if (
      memberId === userId &&
      target.membership.role === "owner" &&
      input.role !== "owner"
    )
      await this.assertAnotherOwner(organizationId);

    await this.db
      .update(organizationMembers)
      .set({ role: input.role })
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, memberId)
        )
      );
    const members = await this.listMembers(userId, organizationId);
    return members.members.find((member) => member.user_id === memberId)!;
  }

  async removeMember(userId: string, organizationId: string, memberId: string) {
    const actor = await this.permissions.organizationEditor(
      userId,
      organizationId
    );
    const [target] = await this.db
      .select({ membership: organizationMembers })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, memberId)
        )
      )
      .limit(1);
    if (!target)
      throw new ApiError(404, "NOT_FOUND", "Organization member not found.");
    if (target.membership.role === "owner" && actor.role !== "owner")
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "Admins cannot remove owners."
      );
    if (memberId === userId && target.membership.role === "owner")
      await this.assertAnotherOwner(organizationId);
    await this.db
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, memberId)
        )
      );
    return { deleted: true as const };
  }

  async leaveOrganization(userId: string, organizationId: string) {
    const membership = await this.permissions.organization(
      userId,
      organizationId
    );
    if (membership.role === "owner")
      await this.assertAnotherOwner(organizationId);
    await this.db
      .delete(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId)
        )
      );
    return { deleted: true as const };
  }

  private async assertAnotherOwner(organizationId: string) {
    const [{ ownerCount }] = await this.db
      .select({ ownerCount: count() })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.role, "owner")
        )
      );
    if (Number(ownerCount) <= 1)
      throw new ApiError(
        409,
        "CONFLICT",
        "The sole organization owner cannot leave or lose ownership."
      );
  }

  async listProjects(userId: string, organizationId: string) {
    await this.permissions.organization(userId, organizationId);
    const rows = await this.db.query.projects.findMany({
      orderBy: asc(projects.name),
      where: eq(projects.organizationId, organizationId)
    });
    return { projects: rows.map(projectJson) };
  }

  async createProject(
    userId: string,
    organizationId: string,
    input: CreateProjectRequest
  ) {
    await this.permissions.organization(userId, organizationId);
    const [project] = await this.db
      .insert(projects)
      .values({
        id: randomUUID(),
        organizationId,
        name: input.name,
        slug: input.slug ?? slugify(input.name),
        description: input.description ?? null,
        taskKeyPrefix:
          input.task_key_prefix ??
          ((input.slug ?? slugify(input.name))
            .replace(/[^a-z0-9]/gi, "")
            .slice(0, 3).length >= 2
            ? (input.slug ?? slugify(input.name))
                .replace(/[^a-z0-9]/gi, "")
                .slice(0, 3)
                .toUpperCase()
            : "PRJ")
      })
      .returning();
    return projectJson(project);
  }

  async getProject(userId: string, projectId: string) {
    return projectJson(await this.permissions.project(userId, projectId));
  }

  async updateProject(
    userId: string,
    projectId: string,
    input: UpdateProjectRequest
  ) {
    await this.permissions.projectEditor(userId, projectId);
    const [project] = await this.db
      .update(projects)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();
    if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    return projectJson(project);
  }

  async archiveProject(userId: string, projectId: string) {
    const { project: current } = await this.permissions.projectEditor(
      userId,
      projectId
    );
    if (current.status === "archived") return projectJson(current);
    const now = new Date();
    const [project] = await this.db
      .update(projects)
      .set({ archivedAt: now, status: "archived", updatedAt: now })
      .where(and(eq(projects.id, projectId), eq(projects.status, "active")))
      .returning();
    if (!project)
      throw new ApiError(409, "CONFLICT", "Project could not be archived.");
    return projectJson(project);
  }

  async reactivateProject(userId: string, projectId: string) {
    const { project: current } = await this.permissions.projectEditor(
      userId,
      projectId
    );
    if (current.status === "active") return projectJson(current);
    const [project] = await this.db
      .update(projects)
      .set({ archivedAt: null, status: "active", updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.status, "archived")))
      .returning();
    if (!project)
      throw new ApiError(409, "CONFLICT", "Project could not be reactivated.");
    return projectJson(project);
  }

  async deleteProject(
    userId: string,
    projectId: string,
    name: string
  ): Promise<DeleteResourceResponse> {
    const current = await this.permissions.projectOwner(userId, projectId);
    if (current.project.name !== name)
      throw new ApiError(409, "CONFLICT", "The project name does not match.");
    const [deleted] = await this.db
      .delete(projects)
      .where(and(eq(projects.id, projectId), eq(projects.name, name)))
      .returning({ id: projects.id });
    if (!deleted) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    return { deleted: true };
  }
}
