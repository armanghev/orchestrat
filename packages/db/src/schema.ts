import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
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

export const taskClaims = pgTable(
  "task_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
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
    releaseReason: text("release_reason")
  },
  (table) => [
    // ponytail: agent/session FKs wait for the Agents phase identity tables.
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
