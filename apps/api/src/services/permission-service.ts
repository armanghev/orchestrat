import {
  organizationMembers,
  organizations,
  projects,
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
    if (!record)
      throw new ApiError(
        403,
        "PERMISSION_DENIED",
        "You do not have access to this organization."
      );
    return record;
  }

  async project(userId: string, projectId: string) {
    const [record] = await this.db
      .select({ project: projects })
      .from(projects)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, projects.organizationId),
          eq(organizationMembers.userId, userId)
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
    return record.project;
  }
}
