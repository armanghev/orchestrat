import { randomUUID } from "node:crypto";
import {
  organizationMembers,
  organizations,
  projects,
  type Database
} from "@orchestrat/db";
import type {
  CreateOrganizationRequest,
  CreateProjectRequest,
  Organization,
  Project,
  UpdateProjectRequest
} from "@orchestrat/protocol";
import { and, asc, eq } from "drizzle-orm";
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
        description: input.description ?? null
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
    await this.permissions.project(userId, projectId);
    const [project] = await this.db
      .update(projects)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();
    if (!project) throw new ApiError(404, "NOT_FOUND", "Project not found.");
    return projectJson(project);
  }

  async archiveProject(userId: string, projectId: string) {
    const current = await this.permissions.project(userId, projectId);
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
}
