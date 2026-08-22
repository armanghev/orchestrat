import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  apiIdempotencyKeys,
  projects,
  taskClaims,
  taskComments,
  taskDependencies,
  tasks,
  users
} from "./schema.js";

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

  const idempotencyConfig = getTableConfig(apiIdempotencyKeys);
  assert.ok(
    idempotencyConfig.indexes.find(
      (index) => index.config.name === "api_idempotency_scope_unique"
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
