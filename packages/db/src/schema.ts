import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  unique,
  jsonb,
  integer,
  bigint,
  boolean,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
};

export const organizationRole = pgEnum("organization_role", [
  "owner",
  "admin",
  "member"
]);
export const projectStatus = pgEnum("project_status", ["active", "archived"]);
export const taskPriority = pgEnum("task_priority", [
  "urgent",
  "high",
  "medium",
  "low",
  "none"
]);
export const taskStatus = pgEnum("task_status", [
  "backlog",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "review",
  "done",
  "cancelled"
]);
export const taskClaimStatus = pgEnum("task_claim_status", [
  "active",
  "released",
  "expired",
  "completed",
  "revoked"
]);
export const agentStatus = pgEnum("agent_status", ["active", "revoked"]);
export const agentSessionStatus = pgEnum("agent_session_status", [
  "active",
  "closed"
]);
export const documentAuthorType = pgEnum("document_author_type", [
  "human",
  "agent"
]);
export const documentUploadMode = pgEnum("document_upload_mode", [
  "single",
  "multipart"
]);
export const documentUploadStatus = pgEnum("document_upload_status", [
  "pending",
  "completed",
  "aborted",
  "expired"
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    authProvider: text("auth_provider").notNull(),
    authSubject: text("auth_subject").notNull(),
    username: text("username"),
    name: text("name").notNull(),
    email: text("email").notNull(),
    avatarUrl: text("avatar_url"),
    isInstanceAdmin: boolean("is_instance_admin").default(false).notNull(),
    ...timestamps
  },
  (table) => [
    uniqueIndex("users_auth_provider_subject_unique").on(
      table.authProvider,
      table.authSubject
    ),
    uniqueIndex("users_username_unique").on(table.username),
    uniqueIndex("users_email_unique").on(table.email),
    check(
      "users_email_normalized",
      sql`${table.email} = lower(btrim(${table.email}))`
    )
  ]
);

export const userPasswords = pgTable(
  "user_passwords",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    passwordHash: text("password_hash").notNull(),
    ...timestamps
  },
  (table) => [
    check(
      "user_passwords_hash_not_blank",
      sql`btrim(${table.passwordHash}) <> ''`
    )
  ]
).enableRLS();

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessTokenHash: text("access_token_hash").notNull(),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    previousRefreshTokenHash: text("previous_refresh_token_hash"),
    accessExpiresAt: timestamp("access_expires_at", {
      withTimezone: true
    }).notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", {
      withTimezone: true
    }).notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("auth_sessions_access_token_unique").on(table.accessTokenHash),
    uniqueIndex("auth_sessions_refresh_token_unique").on(
      table.refreshTokenHash
    ),
    index("auth_sessions_previous_refresh_idx").on(
      table.previousRefreshTokenHash
    ),
    index("auth_sessions_user_idx").on(table.userId)
  ]
).enableRLS();

// A single row (id = 1) recording which account set up an empty instance.
export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: integer("id").primaryKey(),
    bootstrappedBy: uuid("bootstrapped_by").references(() => users.id, {
      onDelete: "set null"
    }),
    bootstrappedAt: timestamp("bootstrapped_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [check("instance_settings_singleton", sql`${table.id} = 1`)]
).enableRLS();

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ...timestamps
  },
  (table) => [uniqueIndex("organizations_slug_unique").on(table.slug)]
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: organizationRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("organization_members_user_id_idx").on(table.userId)
  ]
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    status: projectStatus("status").default("active").notNull(),
    taskKeyPrefix: text("task_key_prefix").default("PRJ").notNull(),
    taskCounter: integer("task_counter").default(1).notNull(),
    ...timestamps,
    archivedAt: timestamp("archived_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("projects_organization_slug_unique").on(
      table.organizationId,
      table.slug
    ),
    index("projects_organization_status_idx").on(
      table.organizationId,
      table.status
    ),
    check(
      "projects_archive_state_consistent",
      sql`(${table.status} = 'active' and ${table.archivedAt} is null) or (${table.status} = 'archived' and ${table.archivedAt} is not null)`
    ),
    check(
      "projects_task_key_prefix_format",
      sql`${table.taskKeyPrefix} ~ '^[A-Z0-9]{2,8}$'`
    ),
    check("projects_task_counter_positive", sql`${table.taskCounter} > 0`)
  ]
);

// Branches (0016). Existing rows moved onto one default branch per project;
// branch-scoped tables below carry branch_id with same-branch composite FKs.
export const projectBranches = pgTable(
  "project_branches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    nameSource: text("name_source")
      .$type<"fallback" | "cli" | "provider" | "user">()
      .notNull(),
    createdVia: text("created_via")
      .$type<"migration" | "dashboard" | "cli" | "agent" | "provider">()
      .notNull(),
    createdByType: documentAuthorType("created_by_type"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    createdByAgentId: uuid("created_by_agent_id"),
    onboardingState: text("onboarding_state")
      .$type<"pending" | "completed">()
      .default("pending")
      .notNull(),
    onboardingChoice: text("onboarding_choice").$type<
      "blank" | "import_all" | "selected"
    >(),
    onboardingCompletedAt: timestamp("onboarding_completed_at", {
      withTimezone: true
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedReason: text("archived_reason").$type<
      "provider_deleted" | "manual" | "replaced_on_connect"
    >(),
    archivedByUserId: uuid("archived_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    ...timestamps
  },
  (table) => [
    unique("project_branches_project_id_id_unique").on(
      table.projectId,
      table.id
    ),
    uniqueIndex("project_branches_active_name_unique")
      .on(table.projectId, table.name)
      .where(sql`${table.archivedAt} is null`),
    uniqueIndex("project_branches_one_default")
      .on(table.projectId)
      .where(sql`${table.isDefault}`),
    index("project_branches_project_archived_idx").on(
      table.projectId,
      table.archivedAt,
      table.updatedAt
    ),
    foreignKey({
      columns: [table.projectId, table.createdByAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "project_branches_created_by_agent_project_fk"
    }),
    check("project_branches_name_not_blank", sql`btrim(${table.name}) <> ''`),
    check(
      "project_branches_default_active",
      sql`not ${table.isDefault} or ${table.archivedAt} is null`
    ),
    check(
      "project_branches_archive_consistent",
      sql`(${table.archivedAt} is null) = (${table.archivedReason} is null)`
    ),
    check(
      "project_branches_created_by_consistent",
      sql`(${table.createdByType} is null and ${table.createdByUserId} is null and ${table.createdByAgentId} is null) or (${table.createdByType} = 'human' and ${table.createdByUserId} is not null and ${table.createdByAgentId} is null) or (${table.createdByType} = 'agent' and ${table.createdByUserId} is null and ${table.createdByAgentId} is not null)`
    )
  ]
).enableRLS();

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull(),
    taskKey: text("task_key").notNull(),
    taskNumber: integer("task_number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    priority: taskPriority("priority").default("none").notNull(),
    status: taskStatus("status").default("backlog").notNull(),
    position: integer("position").default(0).notNull(),
    version: integer("version").default(1).notNull(),
    createdByType: documentAuthorType("created_by_type").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    createdByAgentId: uuid("created_by_agent_id"),
    ...timestamps,
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    // Lineage root for copies made by imports and merges; null = this row.
    originId: uuid("origin_id")
  },
  (table) => [
    unique("tasks_project_id_id_unique").on(table.projectId, table.id),
    unique("tasks_branch_id_id_unique").on(table.branchId, table.id),
    // Copies keep their origin's key, so keys are unique per branch; the
    // project-wide task_counter keeps fresh numbers unique project-wide.
    uniqueIndex("tasks_branch_key_unique").on(table.branchId, table.taskKey),
    uniqueIndex("tasks_branch_number_unique").on(
      table.branchId,
      table.taskNumber
    ),
    uniqueIndex("tasks_branch_origin_unique")
      .on(table.branchId, table.originId)
      .where(sql`${table.originId} is not null`),
    index("tasks_branch_board_order_idx").on(
      table.branchId,
      table.status,
      table.position,
      table.id
    ),
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "tasks_branch_project_fk"
    }).onDelete("cascade"),
    index("tasks_created_by_user_id_idx").on(table.createdByUserId),
    index("tasks_created_by_agent_id_idx").on(table.createdByAgentId),
    foreignKey({
      columns: [table.projectId, table.createdByAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "tasks_created_by_agent_project_fk"
    }),
    check(
      "tasks_author_consistent",
      sql`(${table.createdByType} = 'human' and ${table.createdByUserId} is not null and ${table.createdByAgentId} is null) or (${table.createdByType} = 'agent' and ${table.createdByUserId} is null and ${table.createdByAgentId} is not null)`
    ),
    check("tasks_task_number_positive", sql`${table.taskNumber} > 0`),
    check("tasks_position_non_negative", sql`${table.position} >= 0`),
    check("tasks_version_positive", sql`${table.version} > 0`)
  ]
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    authorType: documentAuthorType("author_type").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    authorAgentId: uuid("author_agent_id"),
    authorName: text("author_name").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    // Per-task, contiguous from 1; assigned under the task row lock.
    sequence: integer("sequence").notNull(),
    mentions: jsonb("mentions")
      .$type<{ type: "human" | "agent"; id: string; name: string }[]>()
      .default([])
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
    originId: uuid("origin_id"),
    // Set on comments copied by imports and merges; they never notify.
    importedAt: timestamp("imported_at", { withTimezone: true })
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "task_comments_branch_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.branchId, table.taskId],
      foreignColumns: [tasks.branchId, tasks.id],
      name: "task_comments_task_branch_fk"
    }).onDelete("cascade"),
    uniqueIndex("task_comments_branch_origin_unique")
      .on(table.branchId, table.originId)
      .where(sql`${table.originId} is not null`),
    uniqueIndex("task_comments_task_sequence_unique").on(
      table.taskId,
      table.sequence
    ),
    index("task_comments_task_created_idx").on(
      table.taskId,
      table.createdAt,
      table.id
    ),
    foreignKey({
      columns: [table.projectId, table.authorAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "task_comments_author_agent_project_fk"
    }),
    foreignKey({
      columns: [table.projectId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.id],
      name: "task_comments_task_project_fk"
    }).onDelete("cascade"),
    check(
      "task_comments_author_consistent",
      sql`(${table.authorType} = 'human' and ${table.authorUserId} is not null and ${table.authorAgentId} is null) or (${table.authorType} = 'agent' and ${table.authorUserId} is null and ${table.authorAgentId} is not null)`
    ),
    check(
      "task_comments_body_not_blank",
      sql`btrim(${table.bodyMarkdown}) <> ''`
    ),
    check("task_comments_sequence_positive", sql`${table.sequence} > 0`)
  ]
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull(),
    taskId: uuid("task_id").notNull(),
    dependsOnTaskId: uuid("depends_on_task_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependsOnTaskId] }),
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "task_dependencies_branch_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.branchId, table.taskId],
      foreignColumns: [tasks.branchId, tasks.id],
      name: "task_dependencies_task_branch_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.branchId, table.dependsOnTaskId],
      foreignColumns: [tasks.branchId, tasks.id],
      name: "task_dependencies_blocker_branch_fk"
    }).onDelete("cascade"),
    index("task_dependencies_branch_task_idx").on(table.branchId, table.taskId),
    foreignKey({
      columns: [table.projectId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.id],
      name: "task_dependencies_task_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.dependsOnTaskId],
      foreignColumns: [tasks.projectId, tasks.id],
      name: "task_dependencies_blocker_project_fk"
    }).onDelete("cascade"),
    index("task_dependencies_project_task_idx").on(
      table.projectId,
      table.taskId
    ),
    index("task_dependencies_project_blocker_idx").on(
      table.projectId,
      table.dependsOnTaskId
    ),
    check(
      "task_dependencies_not_self",
      sql`${table.taskId} <> ${table.dependsOnTaskId}`
    )
  ]
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: agentStatus("status").default("active").notNull(),
    ...timestamps,
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    unique("agents_project_id_id_unique").on(table.projectId, table.id),
    index("agents_project_status_idx").on(table.projectId, table.status),
    check("agents_name_not_blank", sql`btrim(${table.name}) <> ''`),
    check(
      "agents_revocation_state_consistent",
      sql`(${table.status} = 'active' and ${table.revokedAt} is null) or (${table.status} = 'revoked' and ${table.revokedAt} is not null)`
    )
  ]
);

export const agentCredentials = pgTable(
  "agent_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.agentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "agent_credentials_agent_project_fk"
    }).onDelete("cascade"),
    uniqueIndex("agent_credentials_token_hash_unique").on(table.tokenHash),
    index("agent_credentials_project_agent_idx").on(
      table.projectId,
      table.agentId
    ),
    check(
      "agent_credentials_token_hash_not_blank",
      sql`btrim(${table.tokenHash}) <> ''`
    )
  ]
);

export const cliAuthorizationAttempts = pgTable(
  "cli_authorization_attempts",
  {
    id: text("id").primaryKey(),
    secretHash: text("secret_hash").notNull(),
    status: text("status").notNull(),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    credentialHash: text("credential_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    exchangedAt: timestamp("exchanged_at", { withTimezone: true })
  },
  (table) => [
    index("cli_authorization_attempts_expires_idx").on(table.expiresAt),
    check(
      "cli_authorization_attempts_status_valid",
      sql`${table.status} in ('pending', 'approved', 'denied', 'expired', 'exchanged')`
    ),
    check(
      "cli_authorization_attempts_secret_hash_not_blank",
      sql`btrim(${table.secretHash}) <> ''`
    )
  ]
);

export const cliCredentials = pgTable(
  "cli_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Null credentials are user-scoped. Existing project-scoped credentials
    // remain valid during the CLI authorization migration.
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("cli_credentials_token_hash_unique").on(table.tokenHash),
    index("cli_credentials_project_idx").on(table.projectId)
  ]
);

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // A session is pinned to one branch; its claims share it.
    branchId: uuid("branch_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    runtime: text("runtime").notNull(),
    integration: text("integration").notNull(),
    externalSessionId: text("external_session_id"),
    status: agentSessionStatus("status").default("active").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", {
      withTimezone: true
    })
      .defaultNow()
      .notNull()
  },
  (table) => [
    unique("agent_sessions_project_id_id_unique").on(table.projectId, table.id),
    unique("agent_sessions_project_agent_id_id_unique").on(
      table.projectId,
      table.agentId,
      table.id
    ),
    foreignKey({
      columns: [table.projectId, table.agentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "agent_sessions_agent_project_fk"
    }).onDelete("cascade"),
    unique("agent_sessions_branch_id_id_unique").on(table.branchId, table.id),
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "agent_sessions_branch_project_fk"
    }).onDelete("cascade"),
    index("agent_sessions_branch_agent_status_idx").on(
      table.branchId,
      table.agentId,
      table.status
    ),
    check(
      "agent_sessions_runtime_not_blank",
      sql`btrim(${table.runtime}) <> ''`
    ),
    check(
      "agent_sessions_integration_not_blank",
      sql`btrim(${table.integration}) <> ''`
    ),
    check(
      "agent_sessions_end_state_consistent",
      sql`(${table.status} = 'active' and ${table.endedAt} is null) or (${table.status} = 'closed' and ${table.endedAt} is not null)`
    )
  ]
);

export const projectEvents = pgTable(
  "project_events",
  {
    id: serial("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // null = a project-wide event (agents, credentials, branches, repository).
    branchId: uuid("branch_id"),
    type: text("type").notNull(),
    actorAgentId: uuid("actor_agent_id"),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    entityId: uuid("entity_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.actorAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "project_events_actor_agent_project_fk"
    }),
    index("project_events_project_id_id_idx").on(table.projectId, table.id),
    index("project_events_project_branch_id_idx").on(
      table.projectId,
      table.branchId,
      table.id
    ),
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "project_events_branch_project_fk"
    }).onDelete("cascade"),
    check("project_events_type_not_blank", sql`btrim(${table.type}) <> ''`)
  ]
);

export const agentLifecycleEvents = pgTable(
  "agent_lifecycle_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    eventId: integer("event_id"),
    sessionId: uuid("session_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [projects.id],
      name: "agent_lifecycle_events_project_id_projects_id_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.agentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "agent_lifecycle_events_agent_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.sessionId],
      foreignColumns: [agentSessions.projectId, agentSessions.id],
      name: "agent_lifecycle_events_session_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.eventId],
      foreignColumns: [projectEvents.id],
      name: "agent_lifecycle_events_event_id_fk"
    }).onDelete("cascade"),
    uniqueIndex("agent_lifecycle_events_scope_unique").on(
      table.projectId,
      table.agentId,
      table.idempotencyKey
    ),
    index("agent_lifecycle_events_project_idx").on(table.projectId),
    check(
      "agent_lifecycle_events_idempotency_key_not_blank",
      sql`btrim(${table.idempotencyKey}) <> ''`
    ),
    check(
      "agent_lifecycle_events_request_hash_not_blank",
      sql`btrim(${table.requestHash}) <> ''`
    )
  ]
);

export const taskClaims = pgTable(
  "task_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    taskId: uuid("task_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: taskClaimStatus("status").default("active").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true
    }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.agentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "task_claims_agent_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.sessionId],
      foreignColumns: [agentSessions.projectId, agentSessions.id],
      name: "task_claims_session_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.id],
      name: "task_claims_task_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.agentId, table.sessionId],
      foreignColumns: [
        agentSessions.projectId,
        agentSessions.agentId,
        agentSessions.id
      ],
      name: "task_claims_session_agent_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "task_claims_branch_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.branchId, table.taskId],
      foreignColumns: [tasks.branchId, tasks.id],
      name: "task_claims_task_branch_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.branchId, table.sessionId],
      foreignColumns: [agentSessions.branchId, agentSessions.id],
      name: "task_claims_session_branch_fk"
    }).onDelete("cascade"),
    check(
      "task_claims_lifecycle_consistent",
      sql`(${table.status} = 'active' and ${table.releasedAt} is null and ${table.releaseReason} is null and ${table.completedAt} is null) or (${table.status} = 'released' and ${table.releasedAt} is not null and ${table.releaseReason} is not null and ${table.completedAt} is null) or (${table.status} = 'expired' and ${table.releasedAt} is not null and ${table.releaseReason} is null and ${table.completedAt} is null) or (${table.status} = 'completed' and ${table.releasedAt} is null and ${table.releaseReason} is null and ${table.completedAt} is not null) or (${table.status} = 'revoked' and ${table.releasedAt} is not null and ${table.releaseReason} is not null and ${table.completedAt} is null)`
    ),
    uniqueIndex("task_claims_one_active_per_task")
      .on(table.taskId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("task_claims_token_hash_unique").on(table.tokenHash),
    index("task_claims_lease_expiry_idx").on(table.status, table.leaseExpiresAt)
  ]
);

export const apiIdempotencyKeys = pgTable(
  "api_idempotency_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "cascade"
    }),
    operation: text("operation").notNull(),
    resourceId: uuid("resource_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    uniqueIndex("api_idempotency_user_scope_unique")
      .on(table.userId, table.operation, table.resourceId, table.idempotencyKey)
      .where(sql`${table.userId} is not null`),
    uniqueIndex("api_idempotency_agent_scope_unique")
      .on(
        table.agentId,
        table.operation,
        table.resourceId,
        table.idempotencyKey
      )
      .where(sql`${table.agentId} is not null`),
    check(
      "api_idempotency_principal_consistent",
      sql`(${table.userId} is not null and ${table.agentId} is null) or (${table.userId} is null and ${table.agentId} is not null)`
    )
    // ponytail: no retention job yet; add bounded cleanup when idempotency volume requires it.
  ]
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull(),
    path: text("path").notNull(),
    currentRevision: integer("current_revision").default(1).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdByType: documentAuthorType("created_by_type"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    createdByAgentId: uuid("created_by_agent_id"),
    originId: uuid("origin_id"),
    ...timestamps
  },
  (table) => [
    unique("documents_project_id_id_unique").on(table.projectId, table.id),
    unique("documents_branch_id_id_unique").on(table.branchId, table.id),
    uniqueIndex("documents_branch_path_unique").on(table.branchId, table.path),
    uniqueIndex("documents_branch_origin_unique")
      .on(table.branchId, table.originId)
      .where(sql`${table.originId} is not null`),
    index("documents_branch_updated_idx").on(
      table.branchId,
      table.updatedAt,
      table.id
    ),
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "documents_branch_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.createdByAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "documents_created_by_agent_project_fk"
    }),
    check("documents_path_not_blank", sql`btrim(${table.path}) <> ''`),
    check(
      "documents_current_revision_positive",
      sql`${table.currentRevision} > 0`
    ),
    check(
      "documents_author_consistent",
      sql`(${table.createdByType} is null and ${table.createdByUserId} is null and ${table.createdByAgentId} is null) or (${table.createdByType} = 'human' and ${table.createdByUserId} is not null and ${table.createdByAgentId} is null) or (${table.createdByType} = 'agent' and ${table.createdByUserId} is null and ${table.createdByAgentId} is not null)`
    )
  ]
);

export const documentFolders = pgTable(
  "document_folders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull(),
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    uniqueIndex("document_folders_branch_path_unique").on(
      table.branchId,
      table.path
    ),
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "document_folders_branch_project_fk"
    }).onDelete("cascade"),
    check("document_folders_path_not_blank", sql`btrim(${table.path}) <> ''`)
  ]
).enableRLS();

export const documentRevisions = pgTable(
  "document_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    documentId: uuid("document_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    contentMarkdown: text("content_markdown").notNull(),
    contentSizeBytes: bigint("content_size_bytes", { mode: "number" }),
    contentSha256: text("content_sha256"),
    authorType: documentAuthorType("author_type").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    authorAgentId: uuid("author_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    originId: uuid("origin_id")
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "document_revisions_branch_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.branchId, table.documentId],
      foreignColumns: [documents.branchId, documents.id],
      name: "document_revisions_document_branch_fk"
    }).onDelete("cascade"),
    uniqueIndex("document_revisions_branch_origin_unique")
      .on(table.branchId, table.originId)
      .where(sql`${table.originId} is not null`),
    uniqueIndex("document_revisions_document_id_revision_unique").on(
      table.documentId,
      table.revisionNumber
    ),
    foreignKey({
      columns: [table.projectId, table.documentId],
      foreignColumns: [documents.projectId, documents.id],
      name: "document_revisions_document_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.authorAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "document_revisions_author_agent_project_fk"
    }),
    index("document_revisions_document_created_idx").on(
      table.documentId,
      table.createdAt,
      table.id
    ),
    check(
      "document_revisions_revision_number_positive",
      sql`${table.revisionNumber} > 0`
    ),
    check(
      "document_revisions_author_consistent",
      sql`(${table.authorType} = 'human' and ${table.authorUserId} is not null and ${table.authorAgentId} is null) or (${table.authorType} = 'agent' and ${table.authorUserId} is null and ${table.authorAgentId} is not null)`
    ),
    check(
      "document_revisions_content_metadata_consistent",
      sql`(${table.contentSizeBytes} is null and ${table.contentSha256} is null) or (${table.contentSizeBytes} >= 0 and length(${table.contentSha256}) = 64 and regexp_replace(${table.contentSha256}, '[0-9a-f]', '', 'g') = '')`
    )
  ]
);

export const documentAttachments = pgTable(
  "document_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    documentId: uuid("document_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    addedByType: documentAuthorType("added_by_type").notNull(),
    addedByUserId: uuid("added_by_user_id"),
    addedByAgentId: uuid("added_by_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    originId: uuid("origin_id")
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.documentId],
      foreignColumns: [documents.projectId, documents.id],
      name: "document_attachments_document_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "document_attachments_branch_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.branchId, table.documentId],
      foreignColumns: [documents.branchId, documents.id],
      name: "document_attachments_document_branch_fk"
    }).onDelete("cascade"),
    uniqueIndex("document_attachments_branch_origin_unique")
      .on(table.branchId, table.originId)
      .where(sql`${table.originId} is not null`),
    foreignKey({
      columns: [table.addedByUserId],
      foreignColumns: [users.id],
      name: "document_attachments_added_by_user_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.projectId, table.addedByAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "document_attachments_added_by_agent_project_fk"
    }),
    index("document_attachments_document_created_idx").on(
      table.documentId,
      table.createdAt,
      table.id
    ),
    check(
      "document_attachments_size_nonnegative",
      sql`${table.sizeBytes} >= 0`
    ),
    check(
      "document_attachments_author_consistent",
      sql`(${table.addedByType} = 'human' and ${table.addedByUserId} is not null and ${table.addedByAgentId} is null) or (${table.addedByType} = 'agent' and ${table.addedByUserId} is null and ${table.addedByAgentId} is not null)`
    )
  ]
);

export const documentAttachmentUploads = pgTable(
  "document_attachment_uploads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    documentId: uuid("document_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
    uploadMode: documentUploadMode("upload_mode").notNull(),
    providerUploadId: text("provider_upload_id"),
    status: documentUploadStatus("status").default("pending").notNull(),
    actorType: documentAuthorType("actor_type").notNull(),
    actorUserId: uuid("actor_user_id"),
    actorAgentId: uuid("actor_agent_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.documentId],
      foreignColumns: [documents.projectId, documents.id],
      name: "document_attachment_uploads_document_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "document_attachment_uploads_branch_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.branchId, table.documentId],
      foreignColumns: [documents.branchId, documents.id],
      name: "document_attachment_uploads_document_branch_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.actorUserId],
      foreignColumns: [users.id],
      name: "document_attachment_uploads_actor_user_fk"
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.projectId, table.actorAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "document_attachment_uploads_actor_agent_project_fk"
    }),
    index("document_attachment_uploads_project_status_idx").on(
      table.projectId,
      table.status,
      table.expiresAt
    ),
    check(
      "document_attachment_uploads_reserved_nonnegative",
      sql`${table.reservedBytes} >= 0`
    ),
    check(
      "document_attachment_uploads_actor_consistent",
      sql`(${table.actorType} = 'human' and ${table.actorUserId} is not null and ${table.actorAgentId} is null) or (${table.actorType} = 'agent' and ${table.actorUserId} is null and ${table.actorAgentId} is not null)`
    ),
    check(
      "document_attachment_uploads_mode_provider_consistent",
      sql`(${table.uploadMode} = 'single' and ${table.providerUploadId} is null) or (${table.uploadMode} = 'multipart' and ${table.providerUploadId} is not null)`
    )
  ]
);

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: organizationRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.userId] }),
    index("project_members_user_idx").on(table.userId)
  ]
).enableRLS();

export const projectInvitations = pgTable(
  "project_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: uuid("accepted_by").references(() => users.id, {
      onDelete: "restrict"
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    uniqueIndex("project_invitations_token_unique").on(table.tokenHash),
    index("project_invitations_project_idx").on(table.projectId),
    check(
      "project_invitations_token_hash_not_blank",
      sql`btrim(${table.tokenHash}) <> ''`
    ),
    check(
      "project_invitations_acceptance_consistent",
      sql`(${table.acceptedAt} is null and ${table.acceptedBy} is null) or (${table.acceptedAt} is not null and ${table.acceptedBy} is not null)`
    )
  ]
).enableRLS();

export const chats = pgTable(
  "chats",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull(),
    kind: text("kind").$type<"direct" | "group">().notNull(),
    name: text("name"),
    directKey: text("direct_key"),
    hasHuman: boolean("has_human").default(false).notNull(),
    creatorType: documentAuthorType("creator_type").notNull(),
    creatorUserId: uuid("creator_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    creatorAgentId: uuid("creator_agent_id"),
    lastSequence: integer("last_sequence").default(0).notNull(),
    originId: uuid("origin_id"),
    ...timestamps
  },
  (table) => [
    unique("chats_project_id_id_unique").on(table.projectId, table.id),
    unique("chats_branch_id_id_unique").on(table.branchId, table.id),
    uniqueIndex("chats_branch_direct_pair_unique").on(
      table.branchId,
      table.directKey
    ),
    uniqueIndex("chats_branch_origin_unique")
      .on(table.branchId, table.originId)
      .where(sql`${table.originId} is not null`),
    index("chats_branch_updated_idx").on(table.branchId, table.updatedAt),
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "chats_branch_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.creatorAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "chats_creator_agent_project_fk"
    }),
    check(
      "chats_kind_consistent",
      sql`(${table.kind} = 'direct' and ${table.directKey} is not null and ${table.name} is null) or (${table.kind} = 'group' and ${table.directKey} is null and ${table.name} is not null and btrim(${table.name}) <> '')`
    ),
    check(
      "chats_creator_consistent",
      sql`(${table.creatorType} = 'human' and ${table.creatorUserId} is not null and ${table.creatorAgentId} is null) or (${table.creatorType} = 'agent' and ${table.creatorAgentId} is not null and ${table.creatorUserId} is null)`
    ),
    check("chats_last_sequence_nonnegative", sql`${table.lastSequence} >= 0`)
  ]
).enableRLS();

export const chatParticipants = pgTable(
  "chat_participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    chatId: uuid("chat_id").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id"),
    lastReadSequence: integer("last_read_sequence").default(0).notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    unique("chat_participants_user_unique").on(table.chatId, table.userId),
    unique("chat_participants_agent_unique").on(table.chatId, table.agentId),
    index("chat_participants_project_chat_idx").on(
      table.projectId,
      table.chatId
    ),
    index("chat_participants_user_idx").on(table.userId),
    index("chat_participants_agent_idx").on(table.agentId),
    foreignKey({
      columns: [table.projectId, table.chatId],
      foreignColumns: [chats.projectId, chats.id],
      name: "chat_participants_chat_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "chat_participants_branch_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.branchId, table.chatId],
      foreignColumns: [chats.branchId, chats.id],
      name: "chat_participants_chat_branch_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.agentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "chat_participants_agent_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.userId],
      foreignColumns: [projectMembers.projectId, projectMembers.userId],
      name: "chat_participants_user_project_fk"
    }).onDelete("cascade"),
    check(
      "chat_participants_actor_consistent",
      sql`(${table.userId} is not null and ${table.agentId} is null) or (${table.agentId} is not null and ${table.userId} is null)`
    ),
    check(
      "chat_participants_read_nonnegative",
      sql`${table.lastReadSequence} >= 0`
    )
  ]
).enableRLS();

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    chatId: uuid("chat_id").notNull(),
    sequence: integer("sequence").notNull(),
    authorType: documentAuthorType("author_type").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    authorAgentId: uuid("author_agent_id"),
    authorName: text("author_name").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    mentions: jsonb("mentions")
      .$type<{ type: "human" | "agent"; id: string; name: string }[]>()
      .default([])
      .notNull(),
    documentRefs: jsonb("document_refs")
      .$type<{ id: string; path: string }[]>()
      .default([])
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    originId: uuid("origin_id"),
    // Set on messages copied by imports and merges: never unread, never notify.
    importedAt: timestamp("imported_at", { withTimezone: true })
  },
  (table) => [
    unique("chat_messages_sequence_unique").on(table.chatId, table.sequence),
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "chat_messages_branch_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.branchId, table.chatId],
      foreignColumns: [chats.branchId, chats.id],
      name: "chat_messages_chat_branch_fk"
    }).onDelete("cascade"),
    uniqueIndex("chat_messages_branch_origin_unique")
      .on(table.branchId, table.originId)
      .where(sql`${table.originId} is not null`),
    index("chat_messages_project_chat_sequence_idx").on(
      table.projectId,
      table.chatId,
      table.sequence
    ),
    foreignKey({
      columns: [table.projectId, table.chatId],
      foreignColumns: [chats.projectId, chats.id],
      name: "chat_messages_chat_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.authorAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "chat_messages_author_agent_project_fk"
    }),
    check(
      "chat_messages_author_consistent",
      sql`(${table.authorType} = 'human' and ${table.authorUserId} is not null and ${table.authorAgentId} is null) or (${table.authorType} = 'agent' and ${table.authorAgentId} is not null and ${table.authorUserId} is null)`
    ),
    check(
      "chat_messages_body_not_blank",
      sql`btrim(${table.bodyMarkdown}) <> ''`
    ),
    check("chat_messages_sequence_positive", sql`${table.sequence} > 0`)
  ]
).enableRLS();

export const taskWatches = pgTable(
  "task_watches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    taskId: uuid("task_id").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id"),
    // watching | muted
    state: text("state").default("watching").notNull(),
    // created | claimed | commented | mentioned | handoff | explicit
    reason: text("reason").notNull(),
    lastReadSequence: integer("last_read_sequence").default(0).notNull(),
    claimBaselineSequence: integer("claim_baseline_sequence"),
    ...timestamps
  },
  (table) => [
    unique("task_watches_user_unique").on(table.taskId, table.userId),
    unique("task_watches_agent_unique").on(table.taskId, table.agentId),
    index("task_watches_project_agent_idx").on(table.projectId, table.agentId),
    index("task_watches_project_user_idx").on(table.projectId, table.userId),
    foreignKey({
      columns: [table.projectId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.id],
      name: "task_watches_task_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.agentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "task_watches_agent_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.userId],
      foreignColumns: [projectMembers.projectId, projectMembers.userId],
      name: "task_watches_user_project_fk"
    }).onDelete("cascade"),
    check(
      "task_watches_actor_consistent",
      sql`(${table.userId} is not null and ${table.agentId} is null) or (${table.agentId} is not null and ${table.userId} is null)`
    ),
    check(
      "task_watches_state_valid",
      sql`${table.state} in ('watching', 'muted')`
    ),
    check("task_watches_read_nonnegative", sql`${table.lastReadSequence} >= 0`)
  ]
).enableRLS();

export const taskBlocks = pgTable(
  "task_blocks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    taskId: uuid("task_id").notNull(),
    createdByType: documentAuthorType("created_by_type").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    createdByAgentId: uuid("created_by_agent_id"),
    // The claim active when the block was set; informational only.
    claimId: uuid("claim_id").references(() => taskClaims.id, {
      onDelete: "set null"
    }),
    reason: text("reason").notNull(),
    blockingTaskId: uuid("blocking_task_id"),
    blockedOnUserId: uuid("blocked_on_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    blockedOnAgentId: uuid("blocked_on_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // blocking_task_done | blocking_task_cancelled | participant_responded |
    // status_changed | moved_by_human | resolved_by_human | released
    resolution: text("resolution"),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    resolvedByAgentId: uuid("resolved_by_agent_id"),
    resolutionSeenAt: timestamp("resolution_seen_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("task_blocks_one_open_per_task")
      .on(table.taskId)
      .where(sql`${table.resolvedAt} is null`),
    index("task_blocks_open_blocking_task_idx")
      .on(table.projectId, table.blockingTaskId)
      .where(sql`${table.resolvedAt} is null`),
    index("task_blocks_open_blocked_on_idx")
      .on(table.projectId, table.blockedOnAgentId)
      .where(sql`${table.resolvedAt} is null`),
    index("task_blocks_creator_idx").on(
      table.projectId,
      table.createdByAgentId
    ),
    foreignKey({
      columns: [table.projectId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.id],
      name: "task_blocks_task_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.blockingTaskId],
      foreignColumns: [tasks.projectId, tasks.id],
      name: "task_blocks_blocking_task_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.createdByAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "task_blocks_created_by_agent_project_fk"
    }),
    foreignKey({
      columns: [table.projectId, table.blockedOnAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "task_blocks_blocked_on_agent_project_fk"
    }),
    foreignKey({
      columns: [table.projectId, table.resolvedByAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "task_blocks_resolved_by_agent_project_fk"
    }),
    check(
      "task_blocks_creator_consistent",
      sql`(${table.createdByType} = 'human' and ${table.createdByUserId} is not null and ${table.createdByAgentId} is null) or (${table.createdByType} = 'agent' and ${table.createdByAgentId} is not null and ${table.createdByUserId} is null)`
    ),
    check("task_blocks_reason_not_blank", sql`btrim(${table.reason}) <> ''`),
    check(
      "task_blocks_not_self",
      sql`${table.blockingTaskId} is null or ${table.blockingTaskId} <> ${table.taskId}`
    ),
    check(
      "task_blocks_on_single",
      sql`${table.blockedOnUserId} is null or ${table.blockedOnAgentId} is null`
    ),
    check(
      "task_blocks_resolved_by_single",
      sql`${table.resolvedByUserId} is null or ${table.resolvedByAgentId} is null`
    ),
    check(
      "task_blocks_resolution_consistent",
      sql`(${table.resolvedAt} is null and ${table.resolution} is null) or (${table.resolvedAt} is not null and ${table.resolution} is not null)`
    )
  ]
).enableRLS();

export const handoffs = pgTable(
  "handoffs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    chatId: uuid("chat_id").notNull(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    messageSequence: integer("message_sequence").notNull(),
    fromUserId: uuid("from_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    fromAgentId: uuid("from_agent_id"),
    toUserId: uuid("to_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    toAgentId: uuid("to_agent_id"),
    taskId: uuid("task_id"),
    chainId: uuid("chain_id").notNull(),
    hop: integer("hop").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    unique("handoffs_message_unique").on(table.messageId),
    index("handoffs_project_to_agent_created_idx").on(
      table.projectId,
      table.toAgentId,
      table.createdAt
    ),
    index("handoffs_project_to_user_created_idx").on(
      table.projectId,
      table.toUserId,
      table.createdAt
    ),
    index("handoffs_project_from_agent_created_idx").on(
      table.projectId,
      table.fromAgentId,
      table.createdAt
    ),
    index("handoffs_chain_idx").on(table.chainId),
    foreignKey({
      columns: [table.projectId, table.chatId],
      foreignColumns: [chats.projectId, chats.id],
      name: "handoffs_chat_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.id],
      name: "handoffs_task_project_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.fromAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "handoffs_from_agent_project_fk"
    }),
    foreignKey({
      columns: [table.projectId, table.toAgentId],
      foreignColumns: [agents.projectId, agents.id],
      name: "handoffs_to_agent_project_fk"
    }),
    check(
      "handoffs_from_single",
      sql`(${table.fromUserId} is null) <> (${table.fromAgentId} is null)`
    ),
    check(
      "handoffs_to_single",
      sql`(${table.toUserId} is null) <> (${table.toAgentId} is null)`
    ),
    check(
      "handoffs_message_sequence_positive",
      sql`${table.messageSequence} > 0`
    ),
    check("handoffs_hop_nonnegative", sql`${table.hop} >= 0`)
  ]
).enableRLS();
