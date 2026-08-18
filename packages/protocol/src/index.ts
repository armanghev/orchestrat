import { z } from "zod";

export const healthResponseSchema = z.object({ status: z.literal("ok") });
export type HealthResponse = z.infer<typeof healthResponseSchema>;

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9_]+$/);
const fullNameSchema = z.string().trim().min(1).max(120);
const avatarUrlSchema = z.string().url().max(2048).nullable();

export const profileSchema = z.object({
  user_id: z.string().uuid(),
  provider: z.string().min(1),
  username: usernameSchema.nullable(),
  full_name: z.string(),
  email: z.string().email(),
  avatar_url: avatarUrlSchema
});
export type Profile = z.infer<typeof profileSchema>;

export const updateProfileRequestSchema = z.object({
  username: usernameSchema,
  full_name: fullNameSchema,
  avatar_url: avatarUrlSchema
});
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

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

export const updateOrganizationRequestSchema = z
  .object({
    name: nameSchema.optional(),
    slug: slugSchema.optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one organization field is required."
  });
export type UpdateOrganizationRequest = z.infer<
  typeof updateOrganizationRequestSchema
>;

export const deleteResourceRequestSchema = z.object({ name: nameSchema });
export type DeleteResourceRequest = z.infer<
  typeof deleteResourceRequestSchema
>;

export const deleteResourceResponseSchema = z.object({
  deleted: z.literal(true)
});
export type DeleteResourceResponse = z.infer<
  typeof deleteResourceResponseSchema
>;

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

export const organizationMemberSchema = z.object({
  user_id: idSchema,
  username: usernameSchema.nullable(),
  full_name: z.string(),
  email: z.string().email(),
  avatar_url: avatarUrlSchema,
  role: organizationRoleSchema,
  created_at: dateSchema
});
export type OrganizationMember = z.infer<typeof organizationMemberSchema>;

export const organizationMembersResponseSchema = z.object({
  members: z.array(organizationMemberSchema)
});
export type OrganizationMembersResponse = z.infer<
  typeof organizationMembersResponseSchema
>;

export const updateOrganizationMemberRequestSchema = z.object({
  role: organizationRoleSchema
});
export type UpdateOrganizationMemberRequest = z.infer<
  typeof updateOrganizationMemberRequestSchema
>;

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

export const projectStatusSchema = z.enum(["active", "archived"]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectSchema = z.object({
  id: idSchema,
  organization_id: idSchema,
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

export const projectLifecycleRequestSchema = z.object({ name: nameSchema });
export type ProjectLifecycleRequest = z.infer<
  typeof projectLifecycleRequestSchema
>;

export const projectsResponseSchema = z.object({
  projects: z.array(projectSchema)
});
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;

export const idParamsSchema = z.object({ id: idSchema });
export const organizationParamsSchema = z.object({
  organizationId: idSchema
});

// Phase boundaries for future event, MCP, and hook schemas.
export const eventSchema = z.object({
  type: z.string(),
  occurredAt: z.string().datetime()
});
export const mcpSchema = z.object({});
export const hookSchema = z.object({});
