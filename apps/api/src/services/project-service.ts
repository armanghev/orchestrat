import { randomUUID } from "node:crypto";
import {
  organizationMembers,
  organizations,
  projectBranches,
  projectEvents,
  repositoryConnections,
  tasks,
  projectMembers,
  projects,
  users,
  type Database
} from "@orchestrat/db";
import { slugifyName as slugify, slugSuffix } from "@orchestrat/protocol";
import type {
  CreateOrganizationRequest,
  CreateProjectRequest,
  DeleteResourceResponse,
  Organization,
  OrganizationMember,
  Project,
  ProjectSummary,
  UpdateOrganizationMemberRequest,
  UpdateOrganizationRequest,
  UpdateProjectRequest
} from "@orchestrat/protocol";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  notInArray,
  sql
} from "drizzle-orm";
import { ApiError } from "./api-error.js";
import {
  defaultBranchId,
  FALLBACK_DEFAULT_BRANCH_NAME
} from "./branch-context.js";
import { PermissionService } from "./permission-service.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

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

const projectJson = (
  project: typeof projects.$inferSelect,
  role: Project["role"],
  defaultBranchId?: string
): Project => ({
  role,
  ...(defaultBranchId ? { default_branch_id: defaultBranchId } : {}),
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

  constructor(
    private readonly db: Database,
    private readonly assertProjectMemberRemovable: (
      tx: Transaction,
      projectId: string,
      userId: string
    ) => Promise<void>,
    private readonly cleanupProjectStorage?: (
      projectId: string
    ) => Promise<void>
  ) {
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
      const id = randomUUID();
      const base = input.slug ?? slugify(input.name);
      let organization: typeof organizations.$inferSelect | undefined;
      // A chosen slug that's taken is the caller's to fix; a derived one
      // (CLI, SDK and MCP send none) gets a short suffix instead.
      const attempts = input.slug === undefined ? 4 : 1;
      for (
        let attempt = 0;
        attempt < attempts && organization?.id !== id;
        attempt++
      )
        [organization] = await tx
          .insert(organizations)
          .values({
            id,
            name: input.name,
            slug:
              attempt === 0
                ? base
                : `${base.slice(0, 54).replace(/-$/, "")}-${slugSuffix()}`
          })
          .onConflictDoNothing({ target: organizations.slug })
          .returning();
      if (input.slug !== undefined && organization?.id !== id)
        throw new ApiError(
          409,
          "ORGANIZATION_SLUG_TAKEN",
          "This organization slug is already taken.",
          { field: "slug" }
        );
      if (!organization || organization.id !== id)
        throw new ApiError(
          409,
          "CONFLICT",
          "Couldn't find a free organization slug. Try again."
        );
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
    await this.permissions.organizationEditor(userId, organizationId);
    return this.db.transaction(async (tx) => {
      await this.lockOrganization(tx, organizationId);
      const actor = await this.organizationMember(tx, organizationId, userId);
      if (!actor || actor.role === "member")
        throw new ApiError(
          403,
          "PERMISSION_DENIED",
          "Only organization owners and admins can edit this organization."
        );
      const target = await this.organizationMember(
        tx,
        organizationId,
        memberId
      );
      if (!target)
        throw new ApiError(404, "NOT_FOUND", "Organization member not found.");
      if (target.role === "owner" && actor.role !== "owner")
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
      if (target.role === "owner" && input.role !== "owner")
        await this.assertAnotherOwner(tx, organizationId);
      const [membership] = await tx
        .update(organizationMembers)
        .set({ role: input.role })
        .where(
          and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.userId, memberId)
          )
        )
        .returning();
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, memberId))
        .limit(1);
      if (!membership || !user)
        throw new ApiError(404, "NOT_FOUND", "Organization member not found.");
      return memberJson({ user, membership });
    });
  }

  async removeMember(userId: string, organizationId: string, memberId: string) {
    await this.permissions.organizationEditor(userId, organizationId);
    return this.db.transaction(async (tx) => {
      await this.lockOrganization(tx, organizationId);
      const actor = await this.organizationMember(tx, organizationId, userId);
      if (!actor || actor.role === "member")
        throw new ApiError(
          403,
          "PERMISSION_DENIED",
          "Only organization owners and admins can edit this organization."
        );
      const target = await this.organizationMember(
        tx,
        organizationId,
        memberId
      );
      if (!target)
        throw new ApiError(404, "NOT_FOUND", "Organization member not found.");
      if (target.role === "owner" && actor.role !== "owner")
        throw new ApiError(
          403,
          "PERMISSION_DENIED",
          "Admins cannot remove owners."
        );
      if (target.role === "owner")
        await this.assertAnotherOwner(tx, organizationId);
      await this.removeFromProjects(tx, organizationId, memberId);
      await tx
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.userId, memberId)
          )
        );
      return { deleted: true as const };
    });
  }

  async leaveOrganization(userId: string, organizationId: string) {
    await this.permissions.organization(userId, organizationId);
    return this.db.transaction(async (tx) => {
      await this.lockOrganization(tx, organizationId);
      const membership = await this.organizationMember(
        tx,
        organizationId,
        userId
      );
      if (!membership)
        throw new ApiError(
          403,
          "PERMISSION_DENIED",
          "You do not have access to this organization."
        );
      if (membership.role === "owner")
        await this.assertAnotherOwner(tx, organizationId);
      await this.removeFromProjects(tx, organizationId, userId);
      await tx
        .delete(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, organizationId),
            eq(organizationMembers.userId, userId)
          )
        );
      return { deleted: true as const };
    });
  }

  private async assertAnotherOwner(tx: Transaction, organizationId: string) {
    const [{ ownerCount }] = await tx
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

  private async lockOrganization(tx: Transaction, organizationId: string) {
    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for("update");
    if (!organization)
      throw new ApiError(404, "NOT_FOUND", "Organization not found.");
  }

  private async organizationMember(
    tx: Transaction,
    organizationId: string,
    userId: string
  ) {
    const [membership] = await tx
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.organizationId, organizationId),
          eq(organizationMembers.userId, userId)
        )
      )
      .limit(1);
    return membership;
  }

  private async removeFromProjects(
    tx: Transaction,
    organizationId: string,
    userId: string
  ) {
    const rows = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(projects.id))
      .for("update");
    const projectIds = rows.map((row) => row.id);
    if (projectIds.length === 0) return;

    const memberships = await tx
      .select({
        projectId: projectMembers.projectId,
        role: projectMembers.role
      })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.userId, userId),
          inArray(projectMembers.projectId, projectIds)
        )
      );
    const ownerProjectIds = memberships
      .filter((membership) => membership.role === "owner")
      .map((membership) => membership.projectId);
    if (ownerProjectIds.length > 0) {
      const ownerCounts = await tx
        .select({
          projectId: projectMembers.projectId,
          ownerCount: count()
        })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.role, "owner"),
            inArray(projectMembers.projectId, ownerProjectIds)
          )
        )
        .groupBy(projectMembers.projectId);
      if (ownerCounts.some((row) => Number(row.ownerCount) <= 1))
        throw new ApiError(
          409,
          "CONFLICT",
          "The sole project owner cannot leave or lose project access."
        );
    }

    for (const membership of memberships)
      await this.assertProjectMemberRemovable(tx, membership.projectId, userId);
    await tx
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.userId, userId),
          inArray(projectMembers.projectId, projectIds)
        )
      );
  }

  async listProjects(userId: string, organizationId: string) {
    await this.permissions.organization(userId, organizationId);
    const rows = await this.db
      .select({ project: projects, role: projectMembers.role })
      .from(projects)
      .innerJoin(
        projectMembers,
        and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, userId)
        )
      )
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(projects.name));
    const defaults = await this.defaultBranchIds(
      rows.map((row) => row.project.id)
    );
    return {
      projects: rows.map((row) =>
        projectJson(row.project, row.role, defaults.get(row.project.id))
      )
    };
  }

  async listProjectSummaries(userId: string, organizationId: string) {
    await this.permissions.organization(userId, organizationId);
    // Aggregate only the caller's projects; the rest would be discarded.
    const visible = this.db
      .select({ id: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, userId));
    const members = this.db
      .select({
        projectId: projectMembers.projectId,
        total: count().as("member_count")
      })
      .from(projectMembers)
      .innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(
        and(
          eq(projects.organizationId, organizationId),
          inArray(projectMembers.projectId, visible)
        )
      )
      .groupBy(projectMembers.projectId)
      .as("members");
    const openTasks = this.db
      .select({
        projectId: tasks.projectId,
        total: count().as("open_task_count")
      })
      .from(tasks)
      .innerJoin(
        projectBranches,
        and(
          eq(projectBranches.id, tasks.branchId),
          eq(projectBranches.isDefault, true)
        )
      )
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(
          eq(projects.organizationId, organizationId),
          inArray(tasks.projectId, visible),
          notInArray(tasks.status, ["done", "cancelled"])
        )
      )
      .groupBy(tasks.projectId)
      .as("open_tasks");
    const activity = this.db
      .select({
        projectId: projectEvents.projectId,
        latest: sql<Date>`max(${projectEvents.occurredAt})`
          .mapWith(projectEvents.occurredAt)
          .as("last_activity_at")
      })
      .from(projectEvents)
      .innerJoin(projects, eq(projects.id, projectEvents.projectId))
      .where(
        and(
          eq(projects.organizationId, organizationId),
          inArray(projectEvents.projectId, visible)
        )
      )
      .groupBy(projectEvents.projectId)
      .as("activity");
    const rows = await this.db
      .select({
        project: projects,
        role: projectMembers.role,
        defaultBranchId: projectBranches.id,
        defaultBranchName: projectBranches.name,
        memberCount: members.total,
        openTaskCount: openTasks.total,
        lastActivityAt: activity.latest,
        repository: {
          provider: repositoryConnections.provider,
          fullName: repositoryConnections.repositoryFullName,
          status: repositoryConnections.status
        }
      })
      .from(projects)
      .innerJoin(
        projectMembers,
        and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, userId)
        )
      )
      .leftJoin(
        projectBranches,
        and(
          eq(projectBranches.projectId, projects.id),
          eq(projectBranches.isDefault, true)
        )
      )
      .leftJoin(members, eq(members.projectId, projects.id))
      .leftJoin(openTasks, eq(openTasks.projectId, projects.id))
      .leftJoin(activity, eq(activity.projectId, projects.id))
      .leftJoin(
        repositoryConnections,
        and(
          eq(repositoryConnections.projectId, projects.id),
          isNull(repositoryConnections.disconnectedAt)
        )
      )
      .where(eq(projects.organizationId, organizationId))
      .orderBy(asc(projects.name));
    return {
      projects: rows.map((row): ProjectSummary => ({
        ...projectJson(row.project, row.role, row.defaultBranchId ?? undefined),
        task_key_prefix: row.project.taskKeyPrefix,
        default_branch_name: row.defaultBranchName,
        member_count: Number(row.memberCount ?? 0),
        open_task_count: Number(row.openTaskCount ?? 0),
        last_activity_at: row.lastActivityAt?.toISOString() ?? null,
        repository: row.repository
          ? {
              provider: row.repository.provider,
              full_name: row.repository.fullName,
              status: row.repository.status
            }
          : null
      }))
    };
  }

  async createProject(
    userId: string,
    organizationId: string,
    input: CreateProjectRequest
  ) {
    return this.db.transaction(async (tx) => {
      await this.lockOrganization(tx, organizationId);
      if (!(await this.organizationMember(tx, organizationId, userId)))
        throw new ApiError(
          403,
          "PERMISSION_DENIED",
          "You do not have access to this organization."
        );
      const [project] = await tx
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
      await tx.insert(projectMembers).values({
        projectId: project.id,
        userId,
        role: "owner"
      });
      // Every project starts with its default branch (docs/project-branches.md
      // §5.3); Git names it later (§8.7).
      const [branch] = await tx
        .insert(projectBranches)
        .values({
          projectId: project.id,
          name: FALLBACK_DEFAULT_BRANCH_NAME,
          isDefault: true,
          nameSource: "fallback",
          createdVia: "dashboard",
          createdByType: "human",
          createdByUserId: userId,
          onboardingState: "completed",
          onboardingCompletedAt: new Date()
        })
        .returning();
      return projectJson(project, "owner", branch!.id);
    });
  }

  private async defaultBranchIds(projectIds: string[]) {
    if (!projectIds.length) return new Map<string, string>();
    const rows = await this.db
      .select({ projectId: projectBranches.projectId, id: projectBranches.id })
      .from(projectBranches)
      .where(
        and(
          inArray(projectBranches.projectId, projectIds),
          eq(projectBranches.isDefault, true)
        )
      );
    return new Map(rows.map((row) => [row.projectId, row.id]));
  }

  async getProject(userId: string, projectId: string) {
    const record = await this.permissions.projectAccess(userId, projectId);
    return projectJson(
      record.project,
      record.role,
      await defaultBranchId(this.db, projectId)
    );
  }

  async updateProject(
    userId: string,
    projectId: string,
    input: UpdateProjectRequest
  ) {
    const current = await this.permissions.projectEditor(userId, projectId);
    const [project] = await this.db
      .update(projects)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();
    if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    return projectJson(project, current.role);
  }

  async archiveProject(userId: string, projectId: string) {
    const access = await this.permissions.projectEditor(userId, projectId);
    const current = access.project;
    if (current.status === "archived") return projectJson(current, access.role);
    const now = new Date();
    const [project] = await this.db
      .update(projects)
      .set({ archivedAt: now, status: "archived", updatedAt: now })
      .where(and(eq(projects.id, projectId), eq(projects.status, "active")))
      .returning();
    if (!project)
      throw new ApiError(409, "CONFLICT", "Project could not be archived.");
    return projectJson(project, access.role);
  }

  async reactivateProject(userId: string, projectId: string) {
    const access = await this.permissions.projectEditor(userId, projectId);
    const current = access.project;
    if (current.status === "active") return projectJson(current, access.role);
    const [project] = await this.db
      .update(projects)
      .set({ archivedAt: null, status: "active", updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.status, "archived")))
      .returning();
    if (!project)
      throw new ApiError(409, "CONFLICT", "Project could not be reactivated.");
    return projectJson(project, access.role);
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
    await this.cleanupProjectStorage?.(projectId).catch(() => undefined);
    return { deleted: true };
  }
}
