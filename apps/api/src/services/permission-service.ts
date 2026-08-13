import {
  organizationMembers,
  organizations,
  projects,
  workspaces,
  type Database
} from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
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
    if (!record) {
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "You do not have access to this organization."
      );
    }
    return record;
  }

  async workspace(userId: string, workspaceId: string) {
    const [record] = await this.db
      .select({ workspace: workspaces })
      .from(workspaces)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, workspaces.organizationId),
          eq(organizationMembers.userId, userId)
        )
      )
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!record) {
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "You do not have access to this workspace."
      );
    }
    return record.workspace;
  }

  async project(userId: string, projectId: string) {
    const [record] = await this.db
      .select({ project: projects })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, workspaces.organizationId),
          eq(organizationMembers.userId, userId)
        )
      )
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!record) {
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "You do not have access to this project."
      );
    }
    return record.project;
  }
}
