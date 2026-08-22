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
  suggested_username: usernameSchema.nullable().optional(),
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
  "PROJECT_ARCHIVED",
  "TASK_VERSION_CONFLICT",
  "TASK_DEPENDENCY_CYCLE",
  "IDEMPOTENCY_CONFLICT",
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
  description: z.string().trim().max(4000).nullable().optional(),
  task_key_prefix: z
    .string()
    .trim()
    .min(2)
    .max(8)
    .regex(/^[a-zA-Z0-9]+$/)
    .transform((value) => value.toUpperCase())
    .optional()
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

export const taskPrioritySchema = z.enum([
  "urgent",
  "high",
  "medium",
  "low",
  "none"
]);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const taskStatusSchema = z.enum([
  "backlog",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "review",
  "done",
  "cancelled"
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

// Human mutations intentionally cannot select the agent-owned claimed state.
export const humanTaskStatusSchema = taskStatusSchema.exclude(["claimed"]);
export type HumanTaskStatus = z.infer<typeof humanTaskStatusSchema>;

const markdownSchema = z.string().trim().min(1).max(100000);
const taskTitleSchema = z.string().trim().min(1).max(240);
const taskKeySchema = z.string().regex(/^[A-Z0-9]{2,8}-[1-9][0-9]*$/);
const cursorSchema = z.string().trim().min(1).max(2048);
const limitSchema = z.coerce.number().int().min(1).max(100).default(50);
const expectedVersionSchema = z.number().int().min(1);
export const idempotencyKeySchema = z.string().trim().min(1).max(128);

export const taskSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  key: taskKeySchema,
  title: taskTitleSchema,
  description: z.string().nullable(),
  priority: taskPrioritySchema,
  status: taskStatusSchema,
  position: z.number().int().min(0),
  version: z.number().int().min(1),
  created_by_user_id: idSchema,
  created_at: dateSchema,
  updated_at: dateSchema,
  started_at: dateSchema.nullable(),
  completed_at: dateSchema.nullable(),
  cancelled_at: dateSchema.nullable()
});
export type Task = z.infer<typeof taskSchema>;

export const taskCardSchema = taskSchema.extend({
  comment_count: z.number().int().min(0),
  unresolved_blocker_count: z.number().int().min(0)
});
export type TaskCard = z.infer<typeof taskCardSchema>;

export const createTaskRequestSchema = z.object({
  title: taskTitleSchema,
  description: z.string().trim().max(100000).nullable().optional(),
  priority: taskPrioritySchema.optional(),
  status: humanTaskStatusSchema.optional()
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const taskListQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  limit: limitSchema,
  cursor: cursorSchema.optional()
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export const taskListResponseSchema = z.object({
  tasks: z.array(taskCardSchema),
  total: z.number().int().min(0),
  next_cursor: cursorSchema.nullable()
});
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;

export const taskIdParamsSchema = z.object({ id: idSchema });
export const projectTaskParamsSchema = z.object({ projectId: idSchema });

export const updateTaskRequestSchema = z
  .object({
    title: taskTitleSchema.optional(),
    description: z.string().trim().max(100000).nullable().optional(),
    priority: taskPrioritySchema.optional(),
    expected_version: expectedVersionSchema
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.description !== undefined ||
      value.priority !== undefined,
    { message: "At least one task field is required." }
  );
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

export const moveTaskRequestSchema = z.object({
  status: humanTaskStatusSchema,
  before_task_id: idSchema.nullable().optional(),
  expected_version: expectedVersionSchema
});
export type MoveTaskRequest = z.infer<typeof moveTaskRequestSchema>;

export const taskCommentSchema = z.object({
  id: idSchema,
  task_id: idSchema,
  author: z.object({
    user_id: idSchema,
    username: usernameSchema.nullable(),
    full_name: z.string(),
    avatar_url: avatarUrlSchema
  }),
  body_markdown: markdownSchema,
  created_at: dateSchema
});
export type TaskComment = z.infer<typeof taskCommentSchema>;

export const taskCommentsQuerySchema = z.object({
  limit: limitSchema,
  cursor: cursorSchema.optional()
});
export type TaskCommentsQuery = z.infer<typeof taskCommentsQuerySchema>;

export const taskCommentsResponseSchema = z.object({
  comments: z.array(taskCommentSchema),
  next_cursor: cursorSchema.nullable()
});
export type TaskCommentsResponse = z.infer<typeof taskCommentsResponseSchema>;

export const createTaskCommentRequestSchema = z.object({
  body_markdown: markdownSchema
});
export type CreateTaskCommentRequest = z.infer<
  typeof createTaskCommentRequestSchema
>;

export const taskDependencySchema = z.object({
  task_id: idSchema,
  depends_on_task_id: idSchema,
  created_at: dateSchema
});
export type TaskDependency = z.infer<typeof taskDependencySchema>;

export const taskDependenciesResponseSchema = z.object({
  depends_on: z.array(taskSchema),
  blocks: z.array(taskSchema)
});
export type TaskDependenciesResponse = z.infer<
  typeof taskDependenciesResponseSchema
>;

export const createTaskDependencyRequestSchema = z.object({
  depends_on_task_id: idSchema,
  expected_version: expectedVersionSchema
});
export type CreateTaskDependencyRequest = z.infer<
  typeof createTaskDependencyRequestSchema
>;

export const deleteTaskDependencyParamsSchema = z.object({
  id: idSchema,
  dependsOnTaskId: idSchema
});
export const deleteTaskDependencyRequestSchema = z.object({
  expected_version: expectedVersionSchema
});
export type DeleteTaskDependencyRequest = z.infer<
  typeof deleteTaskDependencyRequestSchema
>;

// Phase boundaries for future event, MCP, and hook schemas.
export const eventSchema = z.object({
  type: z.string(),
  occurredAt: z.string().datetime()
});
export const mcpSchema = z.object({});
export const hookSchema = z.object({});
