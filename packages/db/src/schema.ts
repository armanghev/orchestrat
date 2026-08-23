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
    ...timestamps
  },
  (table) => [
    uniqueIndex("users_auth_provider_subject_unique").on(
      table.authProvider,
      table.authSubject
    ),
    uniqueIndex("users_username_unique").on(table.username),
    index("users_email_idx").on(table.email),
    check(
      "users_email_normalized",
      sql`${table.email} = lower(btrim(${table.email}))`
    )
  ]
);

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

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskKey: text("task_key").notNull(),
    taskNumber: integer("task_number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    priority: taskPriority("priority").default("none").notNull(),
    status: taskStatus("status").default("backlog").notNull(),
    position: integer("position").default(0).notNull(),
    version: integer("version").default(1).notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true })
  },
  (table) => [
    unique("tasks_project_id_id_unique").on(table.projectId, table.id),
    uniqueIndex("tasks_project_key_unique").on(table.projectId, table.taskKey),
    uniqueIndex("tasks_project_number_unique").on(
      table.projectId,
      table.taskNumber
    ),
    index("tasks_project_board_order_idx").on(
      table.projectId,
      table.status,
      table.position,
      table.id
    ),
    index("tasks_created_by_user_id_idx").on(table.createdByUserId),
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
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    bodyMarkdown: text("body_markdown").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull()
  },
  (table) => [
    index("task_comments_task_created_idx").on(
      table.taskId,
      table.createdAt,
      table.id
    ),
    check(
      "task_comments_body_not_blank",
      sql`btrim(${table.bodyMarkdown}) <> ''`
    )
  ]
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").notNull(),
    dependsOnTaskId: uuid("depends_on_task_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependsOnTaskId] }),
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

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
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
    index("agent_sessions_project_agent_status_idx").on(
      table.projectId,
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
    check("project_events_type_not_blank", sql`btrim(${table.type}) <> ''`)
  ]
);

export const taskClaims = pgTable(
  "task_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
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
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    uniqueIndex("api_idempotency_scope_unique").on(
      table.userId,
      table.operation,
      table.resourceId,
      table.idempotencyKey
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
    path: text("path").notNull(),
    currentRevision: integer("current_revision").default(1).notNull(),
    createdByType: documentAuthorType("created_by_type"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    createdByAgentId: uuid("created_by_agent_id"),
    ...timestamps
  },
  (table) => [
    unique("documents_project_id_id_unique").on(table.projectId, table.id),
    uniqueIndex("documents_project_path_unique").on(
      table.projectId,
      table.path
    ),
    index("documents_project_updated_idx").on(
      table.projectId,
      table.updatedAt,
      table.id
    ),
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

export const documentRevisions = pgTable(
  "document_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    documentId: uuid("document_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    contentMarkdown: text("content_markdown").notNull(),
    authorType: documentAuthorType("author_type").notNull(),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    authorAgentId: uuid("author_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
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
    )
  ]
);
