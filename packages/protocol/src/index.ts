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

const baseErrorCodeSchema = z.enum([
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL_ERROR"
]);

const taskErrorCodeSchema = z.enum([
  "PROJECT_ARCHIVED",
  "TASK_VERSION_CONFLICT",
  "TASK_DEPENDENCY_CYCLE",
  "IDEMPOTENCY_CONFLICT"
]);

const coordinationErrorCodeSchema = z.enum([
  "AGENT_NOT_FOUND",
  "AGENT_CREDENTIAL_INVALID",
  "AGENT_CREDENTIAL_REVOKED",
  "AGENT_SESSION_NOT_FOUND",
  "AGENT_SESSION_CLOSED",
  "AGENT_SESSION_STALE",
  "TASK_NOT_CLAIMABLE",
  "TASK_ALREADY_CLAIMED",
  "CLAIM_NOT_FOUND",
  "CLAIM_TOKEN_INVALID",
  "CLAIM_NOT_OWNER"
]);

const documentErrorCodeSchema = z.enum(["DOCUMENT_CONFLICT"]);

export const errorCodeSchema = z.union([
  baseErrorCodeSchema,
  taskErrorCodeSchema,
  coordinationErrorCodeSchema,
  documentErrorCodeSchema
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
    request_id: z.string()
  })
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

// The dashboard's existing error union predates task-specific errors. Keep
// that parser source-compatible by making the deliberate fallback explicit.
export const apiErrorSchema = apiErrorResponseSchema.transform((response) => {
  const baseCode = baseErrorCodeSchema.safeParse(response.error.code);
  return {
    ...response,
    error: {
      ...response.error,
      code: baseCode.success ? baseCode.data : "INTERNAL_ERROR"
    }
  };
});

const idSchema = z.string().uuid();
const slugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const nameSchema = z.string().trim().min(1).max(120);
const dateSchema = z.string().datetime();

export const cliAuthorizationStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired"
]);
export type CliAuthorizationStatus = z.infer<
  typeof cliAuthorizationStatusSchema
>;
export const cliAuthorizationAttemptResponseSchema = z.object({
  attempt_id: z.string().min(20),
  secret: z.string().min(32),
  expires_at: dateSchema
});
export type CliAuthorizationAttemptResponse = z.infer<
  typeof cliAuthorizationAttemptResponseSchema
>;
export const cliAuthorizationPollResponseSchema = z.object({
  status: cliAuthorizationStatusSchema,
  project_id: idSchema.nullable().optional(),
  credential: z.string().min(32).optional()
});
export type CliAuthorizationPollResponse = z.infer<
  typeof cliAuthorizationPollResponseSchema
>;
export const cliAuthorizationAttemptParamsSchema = z.object({
  attemptId: z.string().regex(/^ca_[A-Za-z0-9_-]{20,}$/)
});
export const cliAuthorizationPollRequestSchema = z.object({
  secret: z.string().min(32).max(128)
});
export const cliAuthorizationApprovalRequestSchema =
  cliAuthorizationPollRequestSchema.extend({ project_id: idSchema });

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
export type DeleteResourceRequest = z.infer<typeof deleteResourceRequestSchema>;

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

const agentNameSchema = z.string().trim().min(1).max(120);
const integrationNameSchema = z.string().trim().min(1).max(80);
const runtimeNameSchema = z.string().trim().min(1).max(80);
const claimTokenSchema = z.string().trim().min(32).max(512);
export const agentCredentialTokenSchema = z
  .string()
  .trim()
  .max(512)
  .regex(/^orch_agent_[A-Za-z0-9_-]{32,}$/);
const leaseSecondsSchema = z.coerce
  .number()
  .int()
  .min(30)
  .max(86_400)
  .default(300);

export const agentStatusSchema = z.enum(["active", "revoked"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  name: agentNameSchema,
  status: agentStatusSchema,
  created_at: dateSchema,
  updated_at: dateSchema,
  revoked_at: dateSchema.nullable()
});
export type Agent = z.infer<typeof agentSchema>;

export const createAgentRequestSchema = z.object({
  name: agentNameSchema
});
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;

export const agentsResponseSchema = z.object({ agents: z.array(agentSchema) });
export type AgentsResponse = z.infer<typeof agentsResponseSchema>;

export const agentCredentialSchema = z.object({
  id: idSchema,
  agent_id: idSchema,
  project_id: idSchema,
  created_at: dateSchema,
  last_used_at: dateSchema.nullable(),
  revoked_at: dateSchema.nullable()
});
export type AgentCredential = z.infer<typeof agentCredentialSchema>;

export const issueAgentCredentialResponseSchema = z.object({
  credential: agentCredentialSchema,
  token: agentCredentialTokenSchema
});
export type IssueAgentCredentialResponse = z.infer<
  typeof issueAgentCredentialResponseSchema
>;

export const agentSessionStatusSchema = z.enum(["active", "closed"]);
export type AgentSessionStatus = z.infer<typeof agentSessionStatusSchema>;

export const agentSessionSchema = z.object({
  id: idSchema,
  agent_id: idSchema,
  project_id: idSchema,
  runtime: runtimeNameSchema,
  integration: integrationNameSchema,
  external_session_id: z.string().trim().min(1).max(255).nullable(),
  status: agentSessionStatusSchema,
  started_at: dateSchema,
  ended_at: dateSchema.nullable(),
  last_heartbeat_at: dateSchema
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const openAgentSessionRequestSchema = z.object({
  runtime: runtimeNameSchema,
  integration: integrationNameSchema,
  external_session_id: z.string().trim().min(1).max(255).nullable().optional()
});
export type OpenAgentSessionRequest = z.infer<
  typeof openAgentSessionRequestSchema
>;

export const agentSessionParamsSchema = z.object({ sessionId: idSchema });
export const agentSessionResponseSchema = z.object({
  session: agentSessionSchema
});
export type AgentSessionResponse = z.infer<typeof agentSessionResponseSchema>;

export const heartbeatRequestSchema = z.object({
  session_id: idSchema
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

export const heartbeatResponseSchema = z.object({
  session: agentSessionSchema,
  renewed_claim_ids: z.array(idSchema)
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

export const claimStatusSchema = z.enum([
  "active",
  "released",
  "completed",
  "expired",
  "revoked"
]);
export type ClaimStatus = z.infer<typeof claimStatusSchema>;

export const claimSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  task_id: idSchema,
  agent_id: idSchema,
  session_id: idSchema,
  status: claimStatusSchema,
  claimed_at: dateSchema,
  lease_expires_at: dateSchema,
  released_at: dateSchema.nullable(),
  completed_at: dateSchema.nullable()
});
export type Claim = z.infer<typeof claimSchema>;

export const claimTaskRequestSchema = z.object({
  session_id: idSchema,
  lease_seconds: leaseSecondsSchema
});
export type ClaimTaskRequest = z.infer<typeof claimTaskRequestSchema>;

export const claimResponseSchema = z.object({
  claim: claimSchema,
  claim_token: claimTokenSchema
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

export const claimMutationRequestSchema = z.object({
  claim_token: claimTokenSchema
});
export const releaseClaimRequestSchema = claimMutationRequestSchema;
export const completeClaimRequestSchema = claimMutationRequestSchema;
export type ReleaseClaimRequest = z.infer<typeof releaseClaimRequestSchema>;
export type CompleteClaimRequest = z.infer<typeof completeClaimRequestSchema>;

export const agentPresenceStatusSchema = z.enum(["online", "offline"]);
export type AgentPresenceStatus = z.infer<typeof agentPresenceStatusSchema>;

export const agentPresenceSchema = z.object({
  agent_id: idSchema,
  project_id: idSchema,
  session_id: idSchema.nullable(),
  status: agentPresenceStatusSchema,
  last_heartbeat_at: dateSchema.nullable(),
  current_task_id: idSchema.nullable()
});
export type AgentPresence = z.infer<typeof agentPresenceSchema>;

const eventTypeSchema = z.string().trim().min(1).max(80);
export const projectEventSchema = z.object({
  id: z.number().int().positive(),
  project_id: idSchema,
  type: eventTypeSchema,
  actor_agent_id: idSchema.nullable(),
  actor_user_id: idSchema.nullable(),
  entity_id: idSchema.nullable(),
  payload: z.record(z.string(), z.unknown()),
  occurred_at: dateSchema
});
export type ProjectEvent = z.infer<typeof projectEventSchema>;

export const paginationQuerySchema = z.object({
  limit: limitSchema,
  after: cursorSchema.optional()
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const paginationResponseSchema = z.object({
  next_cursor: cursorSchema.nullable()
});
export type PaginationResponse = z.infer<typeof paginationResponseSchema>;

export const projectEventsResponseSchema = paginationResponseSchema.extend({
  events: z.array(projectEventSchema)
});
export type ProjectEventsResponse = z.infer<typeof projectEventsResponseSchema>;

const documentPathSegmentSchema = z
  .string()
  .min(1)
  .refine((segment) => segment !== "." && segment !== "..", {
    message: "Document paths cannot contain dot segments."
  });

/** A normalized, project-relative POSIX path (for example, docs/README.md). */
export const documentPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((path) => !path.startsWith("/"), {
    message: "Document paths must be project-relative."
  })
  .refine((path) => !path.includes("\\") && !path.includes("\0"), {
    message: "Document paths must use POSIX separators and cannot contain NULs."
  })
  .refine(
    (path) =>
      path
        .split("/")
        .every(
          (segment) => documentPathSegmentSchema.safeParse(segment).success
        ),
    { message: "Document paths cannot contain empty or dot segments." }
  );
export type DocumentPath = z.infer<typeof documentPathSchema>;

export const documentAuthorTypeSchema = z.enum(["human", "agent"]);
export type DocumentAuthorType = z.infer<typeof documentAuthorTypeSchema>;
export const documentContentSchema = z.string().max(1_000_000);

const documentAuthorSchema = z.object({
  type: documentAuthorTypeSchema,
  id: idSchema
});

export const documentSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  path: documentPathSchema,
  current_revision: z.number().int().min(1),
  created_by: documentAuthorSchema.nullable(),
  created_at: dateSchema,
  updated_at: dateSchema
});
export type Document = z.infer<typeof documentSchema>;

export const documentRevisionSchema = z.object({
  id: idSchema,
  document_id: idSchema,
  revision_number: z.number().int().min(1),
  content: documentContentSchema,
  author: z.object({
    type: documentAuthorTypeSchema,
    id: idSchema
  }),
  created_at: dateSchema
});
export type DocumentRevision = z.infer<typeof documentRevisionSchema>;

export const documentDetailSchema = z.object({
  document: documentSchema,
  revision: documentRevisionSchema
});
export type DocumentDetail = z.infer<typeof documentDetailSchema>;
export const documentResponseSchema = documentDetailSchema;
export type DocumentResponse = z.infer<typeof documentResponseSchema>;

export const documentListQuerySchema = z.object({
  limit: limitSchema,
  cursor: cursorSchema.optional()
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

export const documentsResponseSchema = z.object({
  documents: z.array(documentSchema),
  next_cursor: cursorSchema.nullable()
});
export type DocumentsResponse = z.infer<typeof documentsResponseSchema>;
export const documentListResponseSchema = documentsResponseSchema;
export type DocumentListResponse = z.infer<typeof documentListResponseSchema>;

export const createDocumentRequestSchema = z.object({
  path: documentPathSchema,
  content: documentContentSchema
});
export type CreateDocumentRequest = z.infer<typeof createDocumentRequestSchema>;

export const createDocumentResponseSchema = documentDetailSchema;
export type CreateDocumentResponse = z.infer<
  typeof createDocumentResponseSchema
>;

export const updateDocumentRequestSchema = z.object({
  content: documentContentSchema,
  base_revision: z.number().int().min(1)
});
export type UpdateDocumentRequest = z.infer<typeof updateDocumentRequestSchema>;

export const updateDocumentResponseSchema = documentDetailSchema;
export type UpdateDocumentResponse = z.infer<
  typeof updateDocumentResponseSchema
>;

export const documentIdParamsSchema = z.object({ id: idSchema });
export const projectDocumentParamsSchema = z.object({ projectId: idSchema });
export const documentRevisionParamsSchema = z.object({
  id: idSchema,
  revision: z.coerce.number().int().min(1)
});

export const documentRevisionsResponseSchema = z.object({
  revisions: z.array(documentRevisionSchema),
  next_cursor: cursorSchema.nullable()
});
export type DocumentRevisionsResponse = z.infer<
  typeof documentRevisionsResponseSchema
>;

export const documentConflictDetailsSchema = z.object({
  current_revision: z.number().int().min(1),
  base_revision: z.number().int().min(1)
});
export type DocumentConflictDetails = z.infer<
  typeof documentConflictDetailsSchema
>;

export const eventSchema = z.object({
  type: z.string(),
  occurredAt: z.string().datetime()
});
export const mcpSchema = z.object({});
export const hookSchema = z.object({});
