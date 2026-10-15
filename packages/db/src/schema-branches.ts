import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn
} from "drizzle-orm/pg-core";
import {
  documentAuthorType,
  organizations,
  projectBranches,
  projects,
  users
} from "./schema.js";

// Merge engine and repository sync tables (docs/project-branches.md §4.3,
// §4.4; migration 0016). One-way import from schema.ts keeps the module graph
// acyclic; packages/db/src/index.ts re-exports both.

export type MergeCounts = Record<string, number>;
export type Fingerprint = Record<string, string>;

export const branchMergeRuns = pgTable(
  "branch_merge_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceBranchId: uuid("source_branch_id").notNull(),
    targetBranchId: uuid("target_branch_id").notNull(),
    kind: text("kind").$type<"import" | "merge">().notNull(),
    trigger: text("trigger").$type<"dashboard" | "provider_merge">().notNull(),
    status: text("status")
      .$type<"applied" | "applied_with_decisions" | "skipped" | "failed">()
      .notNull(),
    skipReason: text("skip_reason").$type<
      "no_source_branch" | "fork" | "same_branch" | "source_empty"
    >(),
    dedupeKey: text("dedupe_key"),
    provider: text("provider").$type<"github" | "gitlab" | "origin">(),
    providerChangeNumber: text("provider_change_number"),
    providerChangeUrl: text("provider_change_url"),
    providerHeadSha: text("provider_head_sha"),
    providerMergeSha: text("provider_merge_sha"),
    selection: jsonb("selection")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    result: jsonb("result")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdByType: documentAuthorType("created_by_type"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "restrict"
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true })
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.sourceBranchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "branch_merge_runs_source_branch_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.targetBranchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "branch_merge_runs_target_branch_fk"
    }).onDelete("cascade"),
    uniqueIndex("branch_merge_runs_dedupe_unique")
      .on(table.projectId, table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
    index("branch_merge_runs_target_created_idx").on(
      table.targetBranchId,
      table.createdAt
    ),
    check(
      "branch_merge_runs_creator_consistent",
      sql`(${table.createdByType} is null and ${table.createdByUserId} is null) or (${table.createdByType} = 'human' and ${table.createdByUserId} is not null)`
    )
  ]
).enableRLS();

export const branchItemBaselines = pgTable(
  "branch_item_baselines",
  {
    projectId: uuid("project_id").notNull(),
    // The pair is stored sorted so one baseline serves both merge directions.
    branchLowId: uuid("branch_low_id").notNull(),
    branchHighId: uuid("branch_high_id").notNull(),
    itemType: text("item_type").$type<"task" | "document" | "chat">().notNull(),
    // Lineage key of the item on the low branch's side (spec §4.3).
    lineageKey: uuid("lineage_key").notNull(),
    fingerprint: jsonb("fingerprint")
      .$type<Fingerprint>()
      .default({})
      .notNull(),
    lastRunId: uuid("last_run_id").references(() => branchMergeRuns.id, {
      onDelete: "set null"
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    primaryKey({
      name: "branch_item_baselines_pk",
      columns: [
        table.branchLowId,
        table.branchHighId,
        table.itemType,
        table.lineageKey
      ]
    }),
    foreignKey({
      columns: [table.projectId, table.branchLowId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "branch_item_baselines_low_branch_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.branchHighId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "branch_item_baselines_high_branch_fk"
    }).onDelete("cascade"),
    index("branch_item_baselines_lineage_idx").on(
      table.projectId,
      table.itemType,
      table.lineageKey
    ),
    check(
      "branch_item_baselines_branch_order",
      sql`${table.branchLowId} < ${table.branchHighId}`
    )
  ]
).enableRLS();

export const branchMergeDecisions = pgTable(
  "branch_merge_decisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => branchMergeRuns.id, { onDelete: "cascade" }),
    sourceBranchId: uuid("source_branch_id").notNull(),
    targetBranchId: uuid("target_branch_id").notNull(),
    itemType: text("item_type").$type<"task" | "document" | "chat">().notNull(),
    lineageKey: uuid("lineage_key").notNull(),
    sourceItemId: uuid("source_item_id").notNull(),
    targetItemId: uuid("target_item_id").notNull(),
    label: text("label").notNull(),
    reason: text("reason")
      .$type<
        | "changed_on_both"
        | "added_on_both"
        | "path_collision"
        | "target_claimed"
      >()
      .notNull(),
    fields: text("fields")
      .array()
      .default(sql`'{}'`)
      .notNull(),
    sourceSnapshot: jsonb("source_snapshot")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    targetSnapshot: jsonb("target_snapshot")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    targetFingerprint: jsonb("target_fingerprint")
      .$type<Fingerprint>()
      .default({})
      .notNull(),
    status: text("status")
      .$type<"open" | "resolved_source" | "resolved_target" | "superseded">()
      .default("open")
      .notNull(),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.sourceBranchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "branch_merge_decisions_source_branch_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.projectId, table.targetBranchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "branch_merge_decisions_target_branch_fk"
    }).onDelete("cascade"),
    uniqueIndex("branch_merge_decisions_open_unique")
      .on(table.targetBranchId, table.itemType, table.lineageKey)
      .where(sql`${table.status} = 'open'`),
    index("branch_merge_decisions_target_status_idx").on(
      table.targetBranchId,
      table.status,
      table.createdAt
    ),
    check(
      "branch_merge_decisions_resolution_consistent",
      sql`(${table.status} = 'open' and ${table.resolvedAt} is null and ${table.resolvedByUserId} is null) or (${table.status} <> 'open' and ${table.resolvedAt} is not null)`
    )
  ]
).enableRLS();

export const repositoryConnections = pgTable(
  "repository_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    provider: text("provider")
      .$type<"github" | "gitlab" | "origin">()
      .notNull(),
    // Stable numeric or opaque provider id; names are never used as keys.
    providerRepositoryId: text("provider_repository_id").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    repositoryUrl: text("repository_url"),
    providerDefaultBranch: text("provider_default_branch").notNull(),
    installationId: text("installation_id"),
    /** Set when imported through an organization integration (0017); a
     * GitLab connection then uses the integration's tokens. */
    integrationId: uuid("integration_id").references(
      (): AnyPgColumn => organizationIntegrations.id,
      { onDelete: "set null" }
    ),
    gitlabHookId: text("gitlab_hook_id"),
    accessTokenCiphertext: text("access_token_ciphertext"),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    webhookSecretCiphertext: text("webhook_secret_ciphertext"),
    connectedByUserId: uuid("connected_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    providerAccountId: text("provider_account_id"),
    status: text("status")
      .$type<
        | "active"
        | "needs_reauthorization"
        | "suspended"
        | "error"
        | "disconnected"
      >()
      .default("active")
      .notNull(),
    statusReason: text("status_reason"),
    hookHealth: jsonb("hook_health").$type<{
      alert_status: string | null;
      disabled_until: string | null;
    }>(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    reconcileState: jsonb("reconcile_state")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("repository_connections_one_active_per_project")
      .on(table.projectId)
      .where(sql`${table.disconnectedAt} is null`),
    uniqueIndex("repository_connections_one_active_per_repo")
      .on(table.provider, table.providerRepositoryId)
      .where(sql`${table.disconnectedAt} is null`),
    index("repository_connections_installation_idx").on(
      table.provider,
      table.installationId
    ),
    check(
      "repository_connections_disconnect_consistent",
      sql`(${table.status} = 'disconnected') = (${table.disconnectedAt} is not null)`
    )
  ]
).enableRLS();

export const repositoryConnectionAttempts = pgTable(
  "repository_connection_attempts",
  {
    id: text("id").primaryKey(),
    // A project's attempt, or (0017) an organization integration's.
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade"
    }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade"
    }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider")
      .$type<"github" | "gitlab" | "origin">()
      .notNull(),
    stateHash: text("state_hash").notNull(),
    pkceVerifierCiphertext: text("pkce_verifier_ciphertext"),
    status: text("status")
      .$type<"pending" | "authorized" | "consumed" | "expired" | "failed">()
      .default("pending")
      .notNull(),
    providerUserId: text("provider_user_id"),
    installationId: text("installation_id"),
    userTokenCiphertext: text("user_token_ciphertext"),
    receiptJti: text("receipt_jti"),
    returnPath: text("return_path"),
    errorCode: text("error_code"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true })
  },
  (table) => [
    unique("repository_connection_attempts_state_hash_unique").on(
      table.stateHash
    ),
    uniqueIndex("repository_connection_attempts_receipt_jti_unique")
      .on(table.receiptJti)
      .where(sql`${table.receiptJti} is not null`),
    index("repository_connection_attempts_expires_idx").on(table.expiresAt),
    check(
      "repository_connection_attempts_one_owner",
      sql`(${table.projectId} is null) <> (${table.organizationId} is null)`
    )
  ]
).enableRLS();

export const repositoryRefs = pgTable(
  "repository_refs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => repositoryConnections.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    headSha: text("head_sha"),
    firstSeenSha: text("first_seen_sha"),
    branchId: uuid("branch_id"),
    // One row per generation of a provider branch name (spec §4.4, §8.2).
    state: text("state")
      .$type<"active" | "deleted">()
      .default("active")
      .notNull(),
    createdSignal: text("created_signal")
      .$type<"event" | "reconcile" | "connect_snapshot">()
      .notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdDeliveryId: text("created_delivery_id"),
    deletedDeliveryId: text("deleted_delivery_id")
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.branchId],
      foreignColumns: [projectBranches.projectId, projectBranches.id],
      name: "repository_refs_branch_project_fk"
    }).onDelete("cascade"),
    uniqueIndex("repository_refs_active_name_unique")
      .on(table.connectionId, table.name)
      .where(sql`${table.state} = 'active'`),
    index("repository_refs_connection_name_idx").on(
      table.connectionId,
      table.name,
      table.deletedAt
    ),
    index("repository_refs_branch_idx").on(table.branchId),
    check(
      "repository_refs_delete_consistent",
      sql`(${table.state} = 'deleted') = (${table.deletedAt} is not null)`
    )
  ]
).enableRLS();

export const repositoryWebhookDeliveries = pgTable(
  "repository_webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider")
      .$type<"github" | "gitlab" | "origin">()
      .notNull(),
    deliveryId: text("delivery_id").notNull(),
    connectionId: uuid("connection_id").references(
      () => repositoryConnections.id,
      { onDelete: "set null" }
    ),
    eventType: text("event_type").notNull(),
    installationId: text("installation_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status")
      .$type<"pending" | "processing" | "applied" | "ignored" | "failed">()
      .default("pending")
      .notNull(),
    attempts: integer("attempts").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true })
  },
  (table) => [
    unique("repository_webhook_deliveries_delivery_unique").on(
      table.provider,
      table.deliveryId
    ),
    index("repository_webhook_deliveries_queue_idx").on(
      table.status,
      table.nextAttemptAt,
      table.receivedAt
    ),
    index("repository_webhook_deliveries_connection_idx").on(
      table.connectionId,
      table.receivedAt
    ),
    check(
      "repository_webhook_deliveries_attempts_nonnegative",
      sql`${table.attempts} >= 0`
    )
  ]
).enableRLS();

// Organization Git integrations (migration 0017): a GitHub App installation
// or a GitLab account connected to an organization, and the repositories it
// reaches. Projects import from them; owners and admins manage them.
export const organizationIntegrations = pgTable(
  "organization_integrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"github" | "gitlab">().notNull(),
    /** GitHub: the installation's account id. GitLab: the user id. */
    providerAccountId: text("provider_account_id").notNull(),
    accountName: text("account_name").notNull(),
    accountType: text("account_type"),
    installationId: text("installation_id"),
    repositorySelection: text("repository_selection")
      .$type<"all" | "selected">()
      .notNull(),
    /** GitLab "selected": provider project ids. */
    selectedRepositoryIds: jsonb("selected_repository_ids")
      .$type<string[]>()
      .default([])
      .notNull(),
    accessTokenCiphertext: text("access_token_ciphertext"),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    status: text("status")
      .$type<"active" | "needs_reauthorization" | "suspended">()
      .default("active")
      .notNull(),
    statusReason: text("status_reason"),
    connectedByUserId: uuid("connected_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
  },
  (table) => [
    unique("organization_integrations_account_unique").on(
      table.organizationId,
      table.provider,
      table.providerAccountId
    ),
    index("organization_integrations_installation_idx").on(
      table.provider,
      table.installationId
    ),
    check(
      "organization_integrations_provider_valid",
      sql`${table.provider} in ('github', 'gitlab')`
    ),
    check(
      "organization_integrations_selection_valid",
      sql`${table.repositorySelection} in ('all', 'selected')`
    ),
    check(
      "organization_integrations_status_valid",
      sql`${table.status} in ('active', 'needs_reauthorization', 'suspended')`
    )
  ]
).enableRLS();

export const organizationRepositories = pgTable(
  "organization_repositories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => organizationIntegrations.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"github" | "gitlab">().notNull(),
    providerRepositoryId: text("provider_repository_id").notNull(),
    fullName: text("full_name").notNull(),
    url: text("url"),
    defaultBranch: text("default_branch"),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** No longer reachable through the integration. */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedByUserId: uuid("dismissed_by_user_id").references(() => users.id, {
      onDelete: "set null"
    })
  },
  (table) => [
    unique("organization_repositories_integration_repo_unique").on(
      table.integrationId,
      table.providerRepositoryId
    ),
    index("organization_repositories_organization_idx").on(table.organizationId)
  ]
).enableRLS();
