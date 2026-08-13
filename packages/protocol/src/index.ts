import { z } from "zod";

export const healthResponseSchema = z.object({ status: z.literal("ok") });
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const errorCodeSchema = z.enum([
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL_ERROR"
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
    request_id: z.string()
  })
});
export type ApiErrorResponse = z.infer<typeof apiErrorSchema>;

const idSchema = z.string().uuid();
const slugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const nameSchema = z.string().trim().min(1).max(120);
const dateSchema = z.string().datetime();

export const organizationRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

export const organizationSchema = z.object({
  id: idSchema,
  name: z.string(),
  slug: z.string(),
  role: organizationRoleSchema,
  created_at: dateSchema,
  updated_at: dateSchema
});
export type Organization = z.infer<typeof organizationSchema>;

export const createOrganizationRequestSchema = z.object({
  name: nameSchema,
  slug: slugSchema.optional()
});
export type CreateOrganizationRequest = z.infer<
  typeof createOrganizationRequestSchema
>;

export const organizationsResponseSchema = z.object({
  organizations: z.array(organizationSchema)
});
export type OrganizationsResponse = z.infer<typeof organizationsResponseSchema>;

export const workspaceSchema = z.object({
  id: idSchema,
  organization_id: idSchema,
  name: z.string(),
  slug: z.string(),
  created_at: dateSchema,
  updated_at: dateSchema
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const createWorkspaceRequestSchema = z.object({
  name: nameSchema,
  slug: slugSchema.optional()
});
export type CreateWorkspaceRequest = z.infer<
  typeof createWorkspaceRequestSchema
>;

export const workspacesResponseSchema = z.object({
  workspaces: z.array(workspaceSchema)
});
export type WorkspacesResponse = z.infer<typeof workspacesResponseSchema>;

export const projectStatusSchema = z.enum(["active", "archived"]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectSchema = z.object({
  id: idSchema,
  workspace_id: idSchema,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  status: projectStatusSchema,
  created_at: dateSchema,
  updated_at: dateSchema,
  archived_at: dateSchema.nullable()
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectRequestSchema = z.object({
  name: nameSchema,
  slug: slugSchema.optional(),
  description: z.string().trim().max(4000).nullable().optional()
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z
  .object({
    name: nameSchema.optional(),
    slug: slugSchema.optional(),
    description: z.string().trim().max(4000).nullable().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one project field is required."
  });
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const projectsResponseSchema = z.object({
  projects: z.array(projectSchema)
});
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;

export const idParamsSchema = z.object({ id: idSchema });
export const organizationParamsSchema = z.object({
  organizationId: idSchema
});
export const workspaceParamsSchema = z.object({ workspaceId: idSchema });

// Phase boundaries for future event, MCP, and hook schemas.
export const eventSchema = z.object({
  type: z.string(),
  occurredAt: z.string().datetime()
});
export const mcpSchema = z.object({});
export const hookSchema = z.object({});
