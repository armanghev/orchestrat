import {
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  type Database
} from "@orchestrat/db";
import { and, asc, eq } from "drizzle-orm";
import { ApiError } from "./api-error.js";

export class PermissionService {
  constructor(private readonly db: Database) {}

  async organization(userId: string, organizationId: string) {
    const [record] = await this.db
      .select({ organization: organizations, role: organizationMembers.role })
      .from(organizations)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, organizations.id),
          eq(organizationMembers.userId, userId)
        )
      )
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!record)
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "You do not have access to this organization."
      );
    return record;
  }

  async organizationEditor(userId: string, organizationId: string) {
    const record = await this.organization(userId, organizationId);
    if (record.role === "member")
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "Only organization owners and admins can edit this organization."
      );
    return record;
  }

  async organizationOwner(userId: string, organizationId: string) {
    const record = await this.organization(userId, organizationId);
    if (record.role !== "owner")
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "Only organization owners can perform this action."
      );
    return record;
  }

  async project(userId: string, projectId: string) {
    return (await this.projectAccess(userId, projectId)).project;
  }

  async projects(userId: string) {
    return this.db
      .select({
        id: projects.id,
        name: projects.name,
        organizationName: organizations.name,
        role: projectMembers.role
      })
      .from(projects)
      .innerJoin(organizations, eq(organizations.id, projects.organizationId))
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, organizations.id),
          eq(organizationMembers.userId, userId)
        )
      )
      .innerJoin(
        projectMembers,
        and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, userId)
        )
      )
      .orderBy(asc(organizations.name), asc(projects.name));
  }

  async projectAccess(userId: string, projectId: string) {
    const [record] = await this.db
      .select({ project: projects, role: projectMembers.role })
      .from(projects)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, projects.organizationId),
          eq(organizationMembers.userId, userId)
        )
      )
      .innerJoin(
        projectMembers,
        and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, userId)
        )
      )
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!record)
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "You do not have access to this project."
      );
    return record;
  }

  async projectEditor(userId: string, projectId: string) {
    const record = await this.projectAccess(userId, projectId);
    if (record.role === "member")
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "Only project owners and admins can edit this project."
      );
    return record;
  }

  async projectOwner(userId: string, projectId: string) {
    const record = await this.projectAccess(userId, projectId);
    if (record.role !== "owner")
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "Only project owners can perform this action."
      );
    return record;
  }
}
