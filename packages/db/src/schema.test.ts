import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  agentLifecycleEvents,
  cliCredentials,
  agentCredentials,
  agentSessions,
  agents,
  apiIdempotencyKeys,
  documentAttachmentUploads,
  documentRevisions,
  documents,
  projectEvents,
  projects,
  taskClaims,
  taskComments,
  taskDependencies,
  tasks,
  users
} from "./schema.js";

test("agent lifecycle idempotency is project/agent scoped and hash-only", async () => {
  const config = getTableConfig(agentLifecycleEvents);
  assert.equal(agentLifecycleEvents.requestHash.notNull, true);
  assert.equal(agentLifecycleEvents.eventId.notNull, false);
  assert.equal(agentLifecycleEvents.sessionId.notNull, false);
  assert.ok(
    config.indexes.find(
      (index) => index.config.name === "agent_lifecycle_events_scope_unique"
    )
  );
  assert.deepEqual(
    config.foreignKeys.map((foreignKey) => foreignKey.getName()).sort(),
    [
      "agent_lifecycle_events_agent_project_fk",
      "agent_lifecycle_events_event_id_fk",
      "agent_lifecycle_events_project_id_projects_id_fk",
      "agent_lifecycle_events_session_project_fk"
    ]
  );
  const sql = await readFile(
    new URL("../drizzle/0008_agent_lifecycle_events.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /request_hash/);
  assert.match(sql, /agent_lifecycle_events_scope_unique/);
  assert.match(sql, /agent_lifecycle_events_event_id_fk/);
  assert.doesNotMatch(sql, /"token"\s+text/);
  const journal = JSON.parse(
    await readFile(
      new URL("../drizzle/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { tag: string }[] };
  assert.equal(journal.entries.at(-1)?.tag, "0011_agent_task_authors");
});

test("CLI credentials can be user-scoped after the authorization migration", async () => {
  assert.equal(cliCredentials.projectId.notNull, false);
  const sql = await readFile(
    new URL("../drizzle/0009_cli_user_credentials.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /ALTER COLUMN "project_id" DROP NOT NULL/);
});

test("users have provider-qualified identity and non-unique email indexes", () => {
  const config = getTableConfig(users);
  assert.equal(users.authProvider.notNull, true);
  assert.equal(users.authProvider.hasDefault, false);

  const identity = config.indexes.find(
    (index) => index.config.name === "users_auth_provider_subject_unique"
  );
  assert.equal(identity?.config.unique, true);
  assert.deepEqual(
    identity?.config.columns.map((column) =>
      "name" in column ? column.name : undefined
    ),
    ["auth_provider", "auth_subject"]
  );

  const email = config.indexes.find(
    (index) => index.config.name === "users_email_idx"
  );
  assert.equal(email?.config.unique, false);
});

test("identity migration labels legacy rows then removes the default", async () => {
  const directory = new URL("../drizzle/", import.meta.url);
  const migrationName = (await readdir(directory)).find((name) =>
    name.startsWith("0001_")
  );
  assert.ok(migrationName, "expected a 0001 identity migration");
  const sql = await readFile(new URL(migrationName, directory), "utf8");
  assert.match(
    sql,
    /ADD COLUMN "auth_provider" text DEFAULT 'legacy' NOT NULL/
  );
  assert.match(sql, /ALTER COLUMN "auth_provider" DROP DEFAULT/);
  assert.match(sql, /DROP INDEX "users_auth_subject_unique"/);
  assert.match(sql, /DROP INDEX "users_email_unique"/);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "users_auth_provider_subject_unique".*"auth_provider","auth_subject"/
  );
  assert.match(sql, /CREATE INDEX "users_email_idx".*"email"/);
});

test("task schema keeps Kanban ordering, versions, and project-scoped keys", () => {
  assert.equal(projects.taskKeyPrefix.hasDefault, true);
  assert.equal(projects.taskCounter.hasDefault, true);
  assert.equal(tasks.position.notNull, true);
  assert.equal(tasks.version.hasDefault, true);
  const config = getTableConfig(tasks);
  assert.ok(
    config.checks.find((check) => check.name === "tasks_position_non_negative")
  );
  assert.equal(
    config.indexes.find(
      (index) => index.config.name === "tasks_project_board_order_idx"
    )?.config.columns.length,
    4
  );
  assert.ok(
    config.indexes.find(
      (index) => index.config.name === "tasks_project_key_unique"
    )
  );
});

test("claims and idempotency schema retain their safety constraints", () => {
  assert.equal(taskComments.bodyMarkdown.notNull, true);
  assert.equal(taskDependencies.projectId.notNull, true);
  const claimConfig = getTableConfig(taskClaims);
  const activeClaim = claimConfig.indexes.find(
    (index) => index.config.name === "task_claims_one_active_per_task"
  );
  assert.equal(activeClaim?.config.unique, true);
  assert.ok(activeClaim?.config.where);
  assert.equal(taskClaims.agentId.notNull, true);
  assert.equal(taskClaims.sessionId.notNull, true);
  assert.equal(taskClaims.lastHeartbeatAt.hasDefault, true);
  assert.equal(taskClaims.completedAt.name, "completed_at");
  assert.ok(
    claimConfig.checks.find(
      (check) => check.name === "task_claims_lifecycle_consistent"
    )
  );
  assert.ok(
    claimConfig.foreignKeys.find(
      (foreignKey) => foreignKey.getName() === "task_claims_task_project_fk"
    )
  );
  assert.equal(
    claimConfig.foreignKeys.some(
      (foreignKey) => foreignKey.getName() === "task_claims_task_id_tasks_id_fk"
    ),
    false
  );

  const idempotencyConfig = getTableConfig(apiIdempotencyKeys);
  for (const name of [
    "api_idempotency_user_scope_unique",
    "api_idempotency_agent_scope_unique"
  ]) {
    const index = idempotencyConfig.indexes.find(
      (candidate) => candidate.config.name === name
    );
    assert.equal(index?.config.unique, true);
    assert.ok(index?.config.where);
  }
  assert.ok(
    idempotencyConfig.checks.find(
      (check) => check.name === "api_idempotency_principal_consistent"
    )
  );
});

test("tasks migration backfills prefixes and creates same-project blockers", async () => {
  const sql = await readFile(
    new URL("../drizzle/0004_tasks_api.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /REGEXP_REPLACE\(UPPER\("slug"\)/);
  assert.match(sql, /LEFT\(REGEXP_REPLACE\(UPPER\("slug"\).*?, 3\)/);
  assert.match(
    sql,
    /task_claim_status" AS ENUM\('active', 'released', 'expired', 'completed', 'revoked'\)/
  );
  assert.match(
    sql,
    /"last_heartbeat_at" timestamp with time zone DEFAULT now\(\) NOT NULL/
  );
  assert.match(sql, /"position" integer DEFAULT 0 NOT NULL/);
  assert.match(
    sql,
    /CONSTRAINT "tasks_position_non_negative" CHECK \("position" >= 0\)/
  );
  assert.match(sql, /CREATE UNIQUE INDEX "task_claims_one_active_per_task"/);
  assert.match(sql, /REFERENCES "public"\."tasks"\("project_id", "id"\)/);
  assert.match(sql, /CREATE TABLE "api_idempotency_keys"/);
  assert.match(
    sql,
    /"body_markdown" text NOT NULL,\n\t"created_at" timestamp\(3\) with time zone DEFAULT now\(\) NOT NULL/
  );
});

test("coordination schema scopes identities, sessions, claims, and events", () => {
  const agentConfig = getTableConfig(agents);
  assert.equal(
    agentConfig.indexes.some(
      (index) => index.config.name === "agents_project_name_unique"
    ),
    false
  );
  assert.ok(
    agentConfig.checks.find(
      (check) => check.name === "agents_revocation_state_consistent"
    )
  );

  const credentialConfig = getTableConfig(agentCredentials);
  assert.ok(
    credentialConfig.indexes.find(
      (index) => index.config.name === "agent_credentials_token_hash_unique"
    )
  );
  assert.equal(agentCredentials.tokenHash.notNull, true);
  assert.equal(agentCredentials.tokenHash.name, "token_hash");

  const sessionConfig = getTableConfig(agentSessions);
  assert.ok(
    sessionConfig.foreignKeys.find(
      (foreignKey) => foreignKey.getName() === "agent_sessions_agent_project_fk"
    )
  );
  assert.ok(
    sessionConfig.checks.find(
      (check) => check.name === "agent_sessions_end_state_consistent"
    )
  );

  const eventConfig = getTableConfig(projectEvents);
  assert.equal(projectEvents.id.name, "id");
  assert.equal(projectEvents.id.getSQLType(), "serial");
  assert.ok(
    eventConfig.indexes.find(
      (index) => index.config.name === "project_events_project_id_id_idx"
    )
  );
  assert.equal(
    eventConfig.indexes.some(
      (index) => index.config.name === "project_events_project_type_id_idx"
    ),
    false
  );
});

test("coordination migration adds project-scoped claim keys without plaintext tokens", async () => {
  const sql = await readFile(
    new URL("../drizzle/0005_coordination_backend.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /CREATE TYPE "public"\."agent_status"/);
  assert.match(sql, /CREATE TABLE "agents"/);
  assert.match(sql, /CREATE TABLE "agent_credentials"/);
  assert.match(sql, /CREATE TABLE "agent_sessions"/);
  assert.match(sql, /CREATE TABLE "project_events"/);
  assert.match(sql, /"id" serial PRIMARY KEY NOT NULL/);
  assert.match(sql, /"token_hash" text NOT NULL/);
  assert.doesNotMatch(sql, /"token" text/);
  assert.match(
    sql,
    /IF EXISTS \(SELECT 1 FROM "task_claims"\).*RAISE EXCEPTION.*task_claims.*empty/s
  );
  assert.match(sql, /DROP CONSTRAINT "task_claims_task_id_tasks_id_fk"/);
  assert.match(sql, /"task_claims" ADD COLUMN "project_id" uuid NOT NULL/);
  assert.match(sql, /"task_claims" ADD COLUMN "completed_at" timestamp/);
  assert.doesNotMatch(sql, /task_claims_project_id_projects_id_fk/);
  assert.match(sql, /task_claims_session_agent_project_fk/);
  assert.match(sql, /task_claims_lifecycle_consistent/);
  assert.doesNotMatch(sql, /agents_project_name_unique/);
  assert.doesNotMatch(sql, /project_events_project_type_id_idx/);
  assert.match(
    await readFile(
      new URL("../drizzle/0004_tasks_api.sql", import.meta.url),
      "utf8"
    ),
    /task_claims_one_active_per_task/
  );
});

test("documents enforce project paths, revisions, and coherent authors", () => {
  assert.equal(documents.path.notNull, true);
  assert.equal(documents.currentRevision.hasDefault, true);
  assert.ok(
    getTableConfig(documents).indexes.find(
      (index) => index.config.name === "documents_project_path_unique"
    )
  );
  assert.ok(
    getTableConfig(documents).checks.find(
      (check) => check.name === "documents_author_consistent"
    )
  );

  const revisionConfig = getTableConfig(documentRevisions);
  assert.equal(documentRevisions.contentMarkdown.notNull, true);
  assert.ok(
    revisionConfig.indexes.find(
      (index) =>
        index.config.name === "document_revisions_document_id_revision_unique"
    )
  );
  assert.ok(
    revisionConfig.foreignKeys.find(
      (foreignKey) =>
        foreignKey.getName() === "document_revisions_document_project_fk"
    )
  );
  assert.ok(
    revisionConfig.checks.find(
      (check) => check.name === "document_revisions_author_consistent"
    )
  );
  assert.ok(
    revisionConfig.checks.find(
      (check) => check.name === "document_revisions_content_metadata_consistent"
    )
  );
  const uploadConfig = getTableConfig(documentAttachmentUploads);
  assert.ok(
    uploadConfig.checks.find(
      (check) =>
        check.name === "document_attachment_uploads_mode_provider_consistent"
    )
  );
});

test("documents migration creates immutable Markdown revision storage", async () => {
  const sql = await readFile(
    new URL("../drizzle/0006_documents.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /CREATE TYPE "public"\."document_author_type"/);
  assert.match(sql, /CREATE TABLE "documents"/);
  assert.match(sql, /CREATE TABLE "document_revisions"/);
  assert.match(sql, /"content_markdown" text NOT NULL/);
  assert.match(sql, /documents_project_path_unique/);
  assert.match(sql, /document_revisions_document_id_revision_unique/);
  assert.match(sql, /document_revisions_document_project_fk/);
  assert.match(sql, /documents_author_consistent/);
  assert.match(sql, /document_revisions_author_consistent/);
});

test("remote document storage migration keeps metadata and upload invariants", async () => {
  const sql = await readFile(
    new URL("../drizzle/0010_remote_document_storage.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /documents" ADD COLUMN "archived_at"/);
  assert.match(sql, /document_revisions_content_metadata_consistent/);
  assert.match(sql, /document_attachment_uploads_mode_provider_consistent/);
  assert.doesNotMatch(sql, /DROP COLUMN.*content_markdown/);
});
