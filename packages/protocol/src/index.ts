import { z } from "zod";
import { attentionErrorCodeSchema } from "./attention.js";
import { branchErrorCodeSchema } from "./branches.js";

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
  "ORGANIZATION_SLUG_TAKEN",
  "RATE_LIMITED",
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

const documentErrorCodeSchema = z.enum([
  "DOCUMENT_CONFLICT",
  "DOCUMENT_EDIT_MISMATCH",
  "DOCUMENT_CONTENT_UNAVAILABLE",
  "DOCUMENT_ARCHIVED",
  "ATTACHMENT_QUOTA_EXCEEDED",
  "ATTACHMENT_UPLOAD_EXPIRED",
  "STORAGE_UPLOAD_FAILED"
]);

export const errorCodeSchema = z.union([
  baseErrorCodeSchema,
  taskErrorCodeSchema,
  coordinationErrorCodeSchema,
  documentErrorCodeSchema,
  attentionErrorCodeSchema,
  branchErrorCodeSchema
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
export const cliAuthorizationApprovalRequestSchema = z.object({}).strict();
export const cliAuthorizationDenyRequestSchema = z.object({}).strict();

export const cliSetupProjectsResponseSchema = z.object({
  projects: z.array(
    z.object({
      id: idSchema,
      name: nameSchema,
      organization_name: nameSchema
    })
  )
});
export type CliSetupProjectsResponse = z.infer<
  typeof cliSetupProjectsResponseSchema
>;

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
  role: organizationRoleSchema.optional(),
  id: idSchema,
  organization_id: idSchema,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  status: projectStatusSchema,
  created_at: dateSchema,
  updated_at: dateSchema,
  archived_at: dateSchema.nullable(),
  default_branch_id: idSchema.optional()
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

const taskObjectSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  branch_id: idSchema.optional(),
  key: taskKeySchema,
  title: taskTitleSchema,
  description: z.string().nullable(),
  priority: taskPrioritySchema,
  status: taskStatusSchema,
  position: z.number().int().min(0),
  version: z.number().int().min(1),
  created_by: z.discriminatedUnion("type", [
    z.object({ type: z.literal("human"), id: idSchema }),
    z.object({ type: z.literal("agent"), id: idSchema })
  ]),
  created_by_user_id: idSchema.nullable(),
  created_at: dateSchema,
  updated_at: dateSchema,
  started_at: dateSchema.nullable(),
  completed_at: dateSchema.nullable(),
  cancelled_at: dateSchema.nullable()
});
const taskCreatorConsistent = (task: z.infer<typeof taskObjectSchema>) =>
  task.created_by.type === "human"
    ? task.created_by_user_id === task.created_by.id
    : task.created_by_user_id === null;
export const taskSchema = taskObjectSchema.refine(taskCreatorConsistent, {
  message: "Task creator fields are inconsistent."
});
export type Task = z.infer<typeof taskSchema>;

export const taskCardSchema = taskObjectSchema
  .extend({
    comment_count: z.number().int().min(0),
    unresolved_blocker_count: z.number().int().min(0)
  })
  .refine(taskCreatorConsistent, {
    message: "Task creator fields are inconsistent."
  });
export type TaskCard = z.infer<typeof taskCardSchema>;

export const createTaskRequestSchema = z.object({
  title: taskTitleSchema,
  description: z.string().trim().max(100000).nullable().optional(),
  priority: taskPrioritySchema.optional(),
  status: humanTaskStatusSchema.optional()
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export const agentCreateTaskRequestSchema = createTaskRequestSchema.extend({
  status: z.enum(["backlog", "ready"]).optional()
});
export type AgentCreateTaskRequest = z.infer<
  typeof agentCreateTaskRequestSchema
>;

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

const taskCommentAuthorFields = {
  username: usernameSchema.nullable(),
  full_name: z.string(),
  avatar_url: avatarUrlSchema
};
export const taskCommentSchema = z.object({
  id: idSchema,
  task_id: idSchema,
  author: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("human"),
      id: idSchema,
      user_id: idSchema,
      agent_id: z.null(),
      ...taskCommentAuthorFields
    }),
    z.object({
      type: z.literal("agent"),
      id: idSchema,
      user_id: z.null(),
      agent_id: idSchema,
      ...taskCommentAuthorFields
    })
  ]),
  body_markdown: markdownSchema,
  sequence: z.number().int().positive(),
  mentions: z.array(
    z.object({
      type: z.enum(["human", "agent"]),
      id: idSchema,
      name: z.string()
    })
  ),
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

// Inline ref: participantRefSchema is declared later and would hit a TDZ error.
export const createTaskCommentRequestSchema = z.object({
  body_markdown: markdownSchema,
  mentions: z
    .array(z.object({ type: z.enum(["human", "agent"]), id: idSchema }))
    .max(20)
    .default([])
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
export const integrationNameSchema = z.string().trim().min(1).max(80);
export const cliSetupIntegrationSchema = z.enum([
  "codex",
  "claude-code",
  "cursor",
  "antigravity",
  "opencode"
]);
export type CliSetupIntegration = z.infer<typeof cliSetupIntegrationSchema>;
export const cliDisconnectRequestSchema = z
  .object({
    project_id: idSchema,
    agent_ids: z.array(idSchema).min(1).max(5),
    revoke_cli: z.boolean().default(false)
  })
  .strict();
export type CliDisconnectRequest = z.infer<typeof cliDisconnectRequestSchema>;
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
  branch_id: idSchema.optional(),
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
  external_session_id: z.string().trim().min(1).max(255).nullable().optional(),
  // Pins the session to a branch; absent = the header branch or the default.
  branch_id: idSchema.optional()
});
export type OpenAgentSessionRequest = z.infer<
  typeof openAgentSessionRequestSchema
>;

export const agentLifecycleEventTypeSchema = z.enum([
  "session.started",
  "session.ended",
  "run.failed"
]);
export type AgentLifecycleEventType = z.infer<
  typeof agentLifecycleEventTypeSchema
>;
export const agentLifecycleHookRequestSchema = z
  .object({
    event: agentLifecycleEventTypeSchema,
    session_id: idSchema,
    runtime: runtimeNameSchema,
    integration: integrationNameSchema,
    external_session_id: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .nullable()
      .optional(),
    error: z.string().trim().max(2000).optional()
  })
  .strict();
export type AgentLifecycleHookRequest = z.infer<
  typeof agentLifecycleHookRequestSchema
>;
export const agentLifecycleHookResponseSchema = z.object({
  event_id: z.number().int().positive(),
  session: agentSessionSchema
});
export type AgentLifecycleHookResponse = z.infer<
  typeof agentLifecycleHookResponseSchema
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
  branch_id: idSchema.optional(),
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
  claim_token: claimTokenSchema,
  acknowledged_through: z.number().int().nonnegative().optional()
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
  branch_id: idSchema.nullable().optional(),
  status: agentPresenceStatusSchema,
  last_heartbeat_at: dateSchema.nullable(),
  current_task_id: idSchema.nullable()
});
export type AgentPresence = z.infer<typeof agentPresenceSchema>;

const eventTypeSchema = z.string().trim().min(1).max(80);
export const projectEventSchema = z.object({
  id: z.number().int().positive(),
  project_id: idSchema,
  // null = a project-wide event (agents, credentials, branches, repository).
  branch_id: idSchema.nullable().optional(),
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

const realtimeTicketSchema = z
  .string()
  .trim()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

export const realtimeTicketRequestSchema = z.object({
  project_id: idSchema
});
export type RealtimeTicketRequest = z.infer<typeof realtimeTicketRequestSchema>;

export const realtimeTicketResponseSchema = z.object({
  ticket: realtimeTicketSchema,
  expires_at: dateSchema
});
export type RealtimeTicketResponse = z.infer<
  typeof realtimeTicketResponseSchema
>;

export const realtimeProjectParamsSchema = z.object({
  projectId: idSchema
});
export const realtimeSocketQuerySchema = z.object({
  ticket: realtimeTicketSchema
});
export type RealtimeProjectParams = z.infer<typeof realtimeProjectParamsSchema>;
export type RealtimeSocketQuery = z.infer<typeof realtimeSocketQuerySchema>;

export const realtimeEntityTypeSchema = z.enum([
  "chat",
  "project",
  "task",
  "claim",
  "agent",
  "credential",
  "session",
  "document",
  "hook",
  "run",
  "branch",
  "merge",
  "decision",
  "repository"
]);
export type RealtimeEntityType = z.infer<typeof realtimeEntityTypeSchema>;

export const realtimeEventEnvelopeSchema = z
  .object({
    project_id: idSchema,
    branch_id: idSchema.nullable().optional(),
    sequence: z.number().int().positive(),
    event_type: eventTypeSchema,
    entity_type: realtimeEntityTypeSchema,
    entity_id: idSchema.nullable(),
    actor: z
      .object({ type: z.enum(["human", "agent"]), id: idSchema })
      .nullable()
      .optional(),
    message_id: idSchema.optional(),
    mentions: z
      .array(z.object({ type: z.enum(["human", "agent"]), id: idSchema }))
      .optional(),
    affected_participant: z
      .object({ type: z.enum(["human", "agent"]), id: idSchema })
      .optional()
  })
  .refine(
    ({ event_type, entity_type }) => event_type.startsWith(`${entity_type}.`),
    {
      path: ["event_type"],
      message: "Event type must be namespaced by its entity type."
    }
  );
export type RealtimeEventEnvelope = z.infer<typeof realtimeEventEnvelopeSchema>;

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

const markdownDocumentPathSchema = documentPathSchema.refine(
  (path) => path.toLowerCase().endsWith(".md"),
  { message: "Document paths must end in .md." }
);

export const documentFolderSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  branch_id: idSchema.optional(),
  path: documentPathSchema,
  created_at: dateSchema
});
export type DocumentFolder = z.infer<typeof documentFolderSchema>;

export const createDocumentFolderRequestSchema = z.object({
  path: documentPathSchema
});
export type CreateDocumentFolderRequest = z.infer<
  typeof createDocumentFolderRequestSchema
>;

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
  branch_id: idSchema.optional(),
  path: documentPathSchema,
  current_revision: z.number().int().min(1),
  archived_at: dateSchema.nullable(),
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
export const historicalDocumentRevisionResponseSchema = z.object({
  revision: documentRevisionSchema
});
export type HistoricalDocumentRevisionResponse = z.infer<
  typeof historicalDocumentRevisionResponseSchema
>;

export const documentListQuerySchema = z.object({
  limit: limitSchema,
  cursor: cursorSchema.optional(),
  include_archived: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(false)
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

export const documentsResponseSchema = z.object({
  documents: z.array(documentSchema),
  folders: z.array(documentFolderSchema).default([]),
  next_cursor: cursorSchema.nullable()
});
export type DocumentsResponse = z.infer<typeof documentsResponseSchema>;
export const documentListResponseSchema = documentsResponseSchema;
export type DocumentListResponse = z.infer<typeof documentListResponseSchema>;

export const createDocumentRequestSchema = z.object({
  path: markdownDocumentPathSchema,
  content: documentContentSchema
});
export type CreateDocumentRequest = z.infer<typeof createDocumentRequestSchema>;

export const createDocumentResponseSchema = documentDetailSchema;
export type CreateDocumentResponse = z.infer<
  typeof createDocumentResponseSchema
>;

export const updateDocumentRequestSchema = z.object({
  content: documentContentSchema,
  base_revision: z.number().int().min(1),
  save_kind: z.literal("autosave").optional()
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
export const documentAttachmentUploadParamsSchema = z.object({
  documentId: idSchema,
  uploadId: idSchema
});
export const documentAttachmentParamsSchema = z.object({
  documentId: idSchema,
  attachmentId: idSchema
});
export const attachmentDownloadQuerySchema = z.object({
  ticket: z.string().min(1).max(256)
});

export const documentEditSchema = z.object({
  old_text: z.string().min(1).max(1_000_000),
  new_text: documentContentSchema
});
export type DocumentEdit = z.infer<typeof documentEditSchema>;
export const editDocumentRequestSchema = z.object({
  base_revision: z.number().int().min(1),
  edits: z.array(documentEditSchema).min(1).max(1000)
});
export type EditDocumentRequest = z.infer<typeof editDocumentRequestSchema>;

export const renameDocumentRequestSchema = z.object({
  path: markdownDocumentPathSchema,
  expected_revision: z.number().int().min(1)
});
export type RenameDocumentRequest = z.infer<typeof renameDocumentRequestSchema>;

export const documentHistoryQuerySchema = z.object({
  view: z.enum(["summary", "detail"]).default("detail"),
  limit: limitSchema,
  cursor: cursorSchema.optional()
});
export type DocumentHistoryQuery = z.infer<typeof documentHistoryQuerySchema>;

export const documentRevisionSummarySchema = z.object({
  id: idSchema,
  document_id: idSchema,
  revision_number: z.number().int().min(1),
  content_size_bytes: z.number().int().nonnegative().nullable(),
  content_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  author: z.object({
    type: documentAuthorTypeSchema,
    id: idSchema
  }),
  created_at: dateSchema
});
export type DocumentRevisionSummary = z.infer<
  typeof documentRevisionSummarySchema
>;
export const documentRevisionSummaryResponseSchema = z.object({
  revisions: z.array(documentRevisionSummarySchema),
  next_cursor: cursorSchema.nullable()
});
export type DocumentRevisionSummaryResponse = z.infer<
  typeof documentRevisionSummaryResponseSchema
>;

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
export const documentEditMismatchDetailsSchema = z.object({
  edit_index: z.number().int().min(0),
  match_count: z.number().int().nonnegative()
});
export type DocumentEditMismatchDetails = z.infer<
  typeof documentEditMismatchDetailsSchema
>;

export const attachmentUploadModeSchema = z.enum(["direct", "multipart"]);
export type AttachmentUploadMode = z.infer<typeof attachmentUploadModeSchema>;
export const attachmentSchema = z.object({
  id: idSchema,
  document_id: idSchema,
  filename: z.string().min(1).max(255),
  content_type: z.string().max(255).nullable(),
  size_bytes: z.number().int().nonnegative(),
  created_at: dateSchema
});
export type Attachment = z.infer<typeof attachmentSchema>;
export const documentAttachmentsResponseSchema = z.object({
  attachments: z.array(attachmentSchema)
});
export type DocumentAttachmentsResponse = z.infer<
  typeof documentAttachmentsResponseSchema
>;
export const createAttachmentUploadRequestSchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(
      (value) =>
        !value.includes("/") &&
        !value.includes("\\") &&
        !/[\0\r\n]/.test(value),
      { message: "Attachment filenames must be a safe basename." }
    ),
  content_type: z.string().trim().max(255).default("application/octet-stream"),
  size_bytes: z
    .number()
    .int()
    .nonnegative()
    .max(2 * 1024 * 1024 * 1024)
});
export type CreateAttachmentUploadRequest = z.infer<
  typeof createAttachmentUploadRequestSchema
>;
export const attachmentUploadSchema = z.object({
  id: idSchema,
  mode: z.enum(["single", "multipart"]),
  upload_url: z.string().url().optional(),
  upload_id: z.string().optional(),
  part_size_bytes: z.number().int().positive().optional(),
  completed_parts: z
    .array(
      z.object({
        part_number: z.number().int().positive(),
        etag: z.string().min(1)
      })
    )
    .optional(),
  expires_at: dateSchema,
  status: z.string().optional()
});
export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;
export const attachmentUploadResponseSchema = z.object({
  upload: attachmentUploadSchema
});
export type AttachmentUploadResponse = z.infer<
  typeof attachmentUploadResponseSchema
>;
export const attachmentUploadInspectionResponseSchema =
  attachmentUploadResponseSchema;
export type AttachmentUploadInspectionResponse = z.infer<
  typeof attachmentUploadInspectionResponseSchema
>;
export const attachmentPartSchema = z.object({
  part_number: z.number().int().positive(),
  upload_url: z.string().url()
});
export const attachmentPartsResponseSchema = z.object({
  parts: z.array(attachmentPartSchema)
});
export const attachmentPartsRequestSchema = z.object({
  part_numbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100)
});
export const completeAttachmentUploadRequestSchema = z.object({
  parts: z
    .array(
      z.object({
        part_number: z.number().int().positive(),
        etag: z.string().min(1)
      })
    )
    .optional()
});
export const attachmentUploadCompletionResponseSchema = z.object({
  attachment: attachmentSchema,
  upload: attachmentUploadSchema.optional()
});
export type AttachmentUploadCompletionResponse = z.infer<
  typeof attachmentUploadCompletionResponseSchema
>;

export const eventSchema = z.object({
  type: z.string(),
  occurredAt: z.string().datetime()
});
export const mcpSchema = z.object({});
export const hookSchema = z.object({});

// Messaging uses authenticated principals; callers never supply an author.
export const participantRefSchema = z.object({
  type: z.enum(["human", "agent"]),
  id: idSchema
});
export type ParticipantRef = z.infer<typeof participantRefSchema>;
export const messageCandidateSchema = participantRefSchema.extend({
  name: z.string(),
  avatar_url: avatarUrlSchema
});
export const messageCandidatesResponseSchema = z.object({
  candidates: z.array(messageCandidateSchema)
});
export type MessageCandidate = z.infer<typeof messageCandidateSchema>;
export const chatSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  branch_id: idSchema.optional(),
  kind: z.enum(["direct", "group"]),
  name: z.string().nullable(),
  has_human: z.boolean(),
  creator: participantRefSchema,
  participants: z.array(messageCandidateSchema),
  is_participant: z.boolean(),
  can_manage: z.boolean(),
  can_join: z.boolean(),
  last_sequence: z.number().int().nonnegative(),
  last_read_sequence: z.number().int().nonnegative(),
  unread_count: z.number().int().nonnegative(),
  mention_count: z.number().int().nonnegative(),
  created_at: dateSchema,
  updated_at: dateSchema
});
export type Chat = z.infer<typeof chatSchema>;
export const chatsResponseSchema = z.object({ chats: z.array(chatSchema) });
export const createChatRequestSchema = z
  .object({
    kind: z.enum(["direct", "group"]),
    name: nameSchema.optional(),
    participants: z.array(participantRefSchema).min(1).max(99)
  })
  .refine((value) => value.kind !== "group" || Boolean(value.name), {
    message: "Groups need a name."
  });
export type CreateChatRequest = z.infer<typeof createChatRequestSchema>;
export const manageChatMembersRequestSchema = z.object({
  action: z.enum(["add", "remove"]),
  participant: participantRefSchema
});
export type ManageChatMembersRequest = z.infer<
  typeof manageChatMembersRequestSchema
>;
export const sendMessageRequestSchema = z.object({
  body_markdown: markdownSchema,
  mentions: z.array(participantRefSchema).max(100).default([]),
  document_ids: z.array(idSchema).max(20).default([])
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;
export const chatMessageSchema = z.object({
  id: idSchema,
  chat_id: idSchema,
  project_id: idSchema,
  branch_id: idSchema.optional(),
  sequence: z.number().int().positive(),
  author: participantRefSchema.extend({ name: z.string() }),
  body_markdown: markdownSchema,
  mentions: z.array(participantRefSchema.extend({ name: z.string() })),
  documents: z.array(z.object({ id: idSchema, path: z.string() })),
  created_at: dateSchema
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export const chatMessagesQuerySchema = z
  .object({
    after: z.coerce.number().int().nonnegative().optional(),
    before: z.coerce.number().int().positive().optional(),
    unread_only: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .transform((value) => value === true || value === "true")
      .default(false),
    limit: z.coerce.number().int().min(1).max(100).default(50)
  })
  .refine((value) => value.after === undefined || value.before === undefined, {
    message: "Use after or before, not both."
  });
export type ChatMessagesQuery = z.infer<typeof chatMessagesQuerySchema>;
export const chatMessagesResponseSchema = z.object({
  messages: z.array(chatMessageSchema),
  has_more: z.boolean(),
  next_after: z.number().int().nullable(),
  next_before: z.number().int().nullable()
});
export const acknowledgeMessagesRequestSchema = z.object({
  through_message_id: idSchema
});
export const acknowledgeMessagesResponseSchema = z.object({
  last_read_sequence: z.number().int().nonnegative()
});
export const inboxSummarySchema = z.object({
  unread_chats: z.array(
    z.object({
      chat_id: idSchema,
      // Set on reads across branches (`all_branches=true`, human attention).
      branch_id: idSchema.optional(),
      unread_count: z.number().int().nonnegative(),
      mention_count: z.number().int().nonnegative()
    })
  )
});
export type InboxSummary = z.infer<typeof inboxSummarySchema>;
export const projectMemberSchema = organizationMemberSchema;
export type ProjectMember = z.infer<typeof projectMemberSchema>;
export const projectMembersResponseSchema = z.object({
  members: z.array(projectMemberSchema)
});
export const addProjectMemberRequestSchema = z.object({
  user_id: idSchema,
  role: organizationRoleSchema.optional()
});
export type AddProjectMemberRequest = z.infer<
  typeof addProjectMemberRequestSchema
>;
export const updateProjectMemberRequestSchema = z.object({
  role: organizationRoleSchema
});
export type UpdateProjectMemberRequest = z.infer<
  typeof updateProjectMemberRequestSchema
>;
export const projectInvitationSchema = z.object({
  id: idSchema,
  project_id: idSchema,
  created_by: idSchema,
  created_at: dateSchema,
  expires_at: dateSchema,
  revoked_at: dateSchema.nullable(),
  accepted_at: dateSchema.nullable()
});
export type ProjectInvitation = z.infer<typeof projectInvitationSchema>;
export const projectInvitationsResponseSchema = z.object({
  invitations: z.array(projectInvitationSchema)
});
export const revokeProjectInvitationResponseSchema = z.object({
  invitation: projectInvitationSchema
});
export type RevokeProjectInvitationResponse = z.infer<
  typeof revokeProjectInvitationResponseSchema
>;
export const createProjectInvitationResponseSchema = z.object({
  invitation: projectInvitationSchema,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
});
export type CreateProjectInvitationResponse = z.infer<
  typeof createProjectInvitationResponseSchema
>;
export const acceptProjectInvitationRequestSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
});
export const acceptProjectInvitationResponseSchema = z.object({
  project: projectSchema
});
export type AcceptProjectInvitationResponse = z.infer<
  typeof acceptProjectInvitationResponseSchema
>;

export const projectChatParamsSchema = z.object({ projectId: idSchema });
export const chatParamsSchema = z.object({ id: idSchema });

export * from "./attention.js";
export * from "./branches.js";
export * from "./merges.js";
export * from "./repository.js";

import {
  repositoryProviderSchema,
  repositoryConnectionStatusSchema
} from "./repository.js";

export const projectSummarySchema = projectSchema.extend({
  task_key_prefix: z.string(),
  default_branch_name: z.string().nullable(),
  member_count: z.number().int().nonnegative(),
  open_task_count: z.number().int().nonnegative(),
  last_activity_at: dateSchema.nullable(),
  repository: z
    .object({
      provider: repositoryProviderSchema,
      full_name: z.string(),
      status: repositoryConnectionStatusSchema
    })
    .nullable()
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export const projectSummariesResponseSchema = z.object({
  projects: z.array(projectSummarySchema)
});
export type ProjectSummariesResponse = z.infer<
  typeof projectSummariesResponseSchema
>;

export const slugifyName = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/g, "") || `item-${crypto.randomUUID().slice(0, 8)}`;
