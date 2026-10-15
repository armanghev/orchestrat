import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  branchItemBaselines,
  branchMergeDecisions,
  branchMergeRuns,
  repositoryConnectionAttempts,
  repositoryConnections,
  repositoryRefs,
  repositoryWebhookDeliveries
} from "./schema-branches.js";
import {
  agentLifecycleEvents,
  documentAttachments,
  projectBranches,
  cliCredentials,
  agentCredentials,
  agentSessions,
  agents,
  apiIdempotencyKeys,
  chatMessages,
  chatParticipants,
  chats,
  documentAttachmentUploads,
  documentFolders,
  documentRevisions,
  documents,
  handoffs,
  projectEvents,
  projectInvitations,
  projectMembers,
  projects,
  taskBlocks,
  taskClaims,
  taskComments,
  taskDependencies,
  taskWatches,
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
  assert.equal(journal.entries.at(-1)?.tag, "0018_builtin_auth");
});

test("agent attention schema matches the 0015 migration", async () => {
  assert.equal(taskComments.sequence.notNull, true);
  assert.equal(taskComments.mentions.notNull, true);
  assert.equal(taskComments.mentions.hasDefault, true);
  const commentConfig = getTableConfig(taskComments);
  assert.ok(
    commentConfig.indexes.find(
      (index) => index.config.name === "task_comments_task_sequence_unique"
    )?.config.unique
  );
  assert.ok(
    commentConfig.checks.find(
      (check) => check.name === "task_comments_sequence_positive"
    )
  );

  for (const table of [taskWatches, taskBlocks, handoffs])
    assert.equal(getTableConfig(table).enableRLS, true);
  assert.equal(taskWatches.state.hasDefault, true);
  assert.equal(taskWatches.lastReadSequence.hasDefault, true);
  assert.equal(taskWatches.claimBaselineSequence.notNull, false);
  const openBlock = getTableConfig(taskBlocks).indexes.find(
    (index) => index.config.name === "task_blocks_one_open_per_task"
  );
  assert.ok(openBlock?.config.unique);
  assert.ok(openBlock?.config.where);
  assert.equal(handoffs.hop.hasDefault, true);

  const sql = await readFile(
    new URL("../drizzle/0015_agent_attention.sql", import.meta.url),
    "utf8"
  );
  const constraintNames = (table: Parameters<typeof getTableConfig>[0]) => {
    const config = getTableConfig(table);
    return [
      ...config.foreignKeys.map((foreignKey) => foreignKey.getName()),
      ...config.checks.map((check) => check.name),
      ...config.uniqueConstraints.map((unique) => unique.getName()),
      ...config.indexes.map((index) => index.config.name!)
    ];
  };
  for (const table of [taskWatches, taskBlocks, handoffs]) {
    const name = getTableConfig(table).name;
    assert.match(sql, new RegExp(`CREATE TABLE "${name}"`));
    assert.match(
      sql,
      new RegExp(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`)
    );
    for (const constraint of constraintNames(table))
      assert.match(sql, new RegExp(`"${constraint}"`), constraint);
  }
  for (const constraint of [
    "task_comments_sequence_positive",
    "task_comments_task_sequence_unique"
  ])
    assert.match(sql, new RegExp(`"${constraint}"`));
  assert.match(sql, /row_number\(\) OVER \(PARTITION BY "task_id"/);
  assert.match(sql, /ALTER COLUMN "sequence" SET NOT NULL/);
  for (const reason of ["claimed", "created", "commented"])
    assert.match(sql, new RegExp(`'${reason}'`));
  assert.doesNotMatch(sql, /branch/i);
});

test("project messaging schema preserves access, authorship, and ordering", async () => {
  assert.equal(projectMembers.role.notNull, true);
  assert.equal(projectInvitations.tokenHash.notNull, true);
  assert.equal(chats.hasHuman.hasDefault, true);
  assert.equal(chats.lastSequence.hasDefault, true);
  assert.equal(chatParticipants.lastReadSequence.hasDefault, true);
  assert.equal(chatMessages.bodyMarkdown.notNull, true);
  assert.equal(chatMessages.sequence.notNull, true);
  for (const table of [
    documentFolders,
    projectMembers,
    projectInvitations,
    chats,
    chatParticipants,
    chatMessages
  ])
    assert.equal(getTableConfig(table).enableRLS, true);

  const chatConfig = getTableConfig(chats);
  assert.ok(
    chatConfig.indexes.find(
      (index) => index.config.name === "chats_branch_direct_pair_unique"
    )?.config.unique
  );
  assert.equal(
    chatConfig.foreignKeys.some(
      (foreignKey) => foreignKey.getName() === "chats_creator_user_project_fk"
    ),
    false
  );
  assert.ok(
    getTableConfig(chatParticipants).foreignKeys.find(
      (foreignKey) =>
        foreignKey.getName() === "chat_participants_user_project_fk"
    )
  );

  const sql = await readFile(
    new URL("../drizzle/0013_project_messaging.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /CREATE TABLE "project_members"/);
  assert.match(sql, /INSERT INTO "project_members"/);
  assert.match(sql, /ON CONFLICT \("project_id", "user_id"\) DO NOTHING/);
  assert.match(sql, /CREATE TABLE "chat_messages"/);
  assert.match(sql, /chats_direct_pair_unique/);
  assert.match(sql, /chat_messages_sequence_unique/);
  for (const table of [
    "document_folders",
    "project_members",
    "project_invitations",
    "chats",
    "chat_participants",
    "chat_messages"
  ])
    assert.match(
      sql,
      new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
    );
  assert.doesNotMatch(sql, /chats_creator_user_project_fk/);
});

test("CLI credentials can be user-scoped after the authorization migration", async () => {
  assert.equal(cliCredentials.projectId.notNull, false);
  const sql = await readFile(
    new URL("../drizzle/0009_cli_user_credentials.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /ALTER COLUMN "project_id" DROP NOT NULL/);
});

test("users have provider-qualified identity and one account per email", () => {
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
    (index) => index.config.name === "users_email_unique"
  );
  assert.equal(email?.config.unique, true);
  assert.equal(
    config.indexes.some((index) => index.config.name === "users_email_idx"),
    false,
    "the unique index replaces the plain one"
  );
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

test("task schema keeps Kanban ordering, versions, and branch-scoped keys", () => {
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
      (index) => index.config.name === "tasks_branch_board_order_idx"
    )?.config.columns.length,
    4
  );
  assert.ok(
    config.indexes.find(
      (index) => index.config.name === "tasks_branch_key_unique"
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
      (index) => index.config.name === "documents_branch_path_unique"
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

test("migration journal applies in order: each when exceeds the previous", async () => {
  // drizzle-kit migrate skips any migration whose `when` is not greater than
  // the newest applied one, so an out-of-order entry is silently lost
  // (docs/project-branches.md §15.2).
  const journal = JSON.parse(
    await readFile(
      new URL("../drizzle/meta/_journal.json", import.meta.url),
      "utf8"
    )
  ) as { entries: { idx: number; when: number; tag: string }[] };
  for (let index = 1; index < journal.entries.length; index += 1) {
    const previous = journal.entries[index - 1];
    const entry = journal.entries[index];
    assert.ok(entry.idx > previous.idx, entry.tag);
    assert.ok(entry.when > previous.when, entry.tag);
  }
  const files = (await readdir(new URL("../drizzle/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.replace(/\.sql$/, ""))
    .sort();
  assert.deepEqual(
    files,
    journal.entries.map((entry) => entry.tag)
  );
});

test("project branches schema matches the 0016 migration", async () => {
  const scoped = [
    tasks,
    taskComments,
    taskDependencies,
    taskClaims,
    agentSessions,
    documents,
    documentFolders,
    documentRevisions,
    documentAttachments,
    documentAttachmentUploads,
    chats,
    chatParticipants,
    chatMessages
  ];
  for (const table of scoped) {
    const config = getTableConfig(table);
    assert.equal(
      config.columns.find((column) => column.name === "branch_id")?.notNull,
      true,
      config.name
    );
    assert.ok(
      config.foreignKeys.some(
        (foreignKey) =>
          foreignKey.getName() === `${config.name}_branch_project_fk`
      ),
      config.name
    );
  }
  assert.equal(projectEvents.branchId.notNull, false);
  for (const table of [
    projectBranches,
    branchMergeRuns,
    branchItemBaselines,
    branchMergeDecisions,
    repositoryConnections,
    repositoryConnectionAttempts,
    repositoryRefs,
    repositoryWebhookDeliveries
  ])
    assert.equal(getTableConfig(table).enableRLS, true);

  const branchConfig = getTableConfig(projectBranches);
  for (const name of [
    "project_branches_active_name_unique",
    "project_branches_one_default"
  ])
    assert.ok(
      branchConfig.indexes.find((index) => index.config.name === name)?.config
        .unique,
      name
    );
  for (const [table, name] of [
    [taskComments, "task_comments_task_branch_fk"],
    [taskDependencies, "task_dependencies_task_branch_fk"],
    [taskDependencies, "task_dependencies_blocker_branch_fk"],
    [taskClaims, "task_claims_task_branch_fk"],
    [taskClaims, "task_claims_session_branch_fk"],
    [documentRevisions, "document_revisions_document_branch_fk"],
    [documentAttachments, "document_attachments_document_branch_fk"],
    [chatParticipants, "chat_participants_chat_branch_fk"],
    [chatMessages, "chat_messages_chat_branch_fk"]
  ] as const)
    assert.ok(
      getTableConfig(table).foreignKeys.some(
        (foreignKey) => foreignKey.getName() === name
      ),
      name
    );
  for (const [table, name] of [
    [tasks, "tasks_project_key_unique"],
    [documents, "documents_project_path_unique"],
    [documentFolders, "document_folders_project_path_unique"],
    [chats, "chats_direct_pair_unique"]
  ] as const)
    assert.equal(
      getTableConfig(table).indexes.some((index) => index.config.name === name),
      false,
      name
    );

  const sql = await readFile(
    new URL("../drizzle/0016_project_branches.sql", import.meta.url),
    "utf8"
  );
  for (const table of [
    "project_branches",
    "branch_merge_runs",
    "branch_item_baselines",
    "branch_merge_decisions",
    "repository_connections",
    "repository_connection_attempts",
    "repository_refs",
    "repository_webhook_deliveries"
  ])
    assert.match(
      sql,
      new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
    );
  assert.match(
    sql,
    /SELECT gen_random_uuid\(\), "id", 'main', true, 'fallback'/
  );
  for (const name of [
    "tasks_project_key_unique",
    "documents_project_path_unique",
    "document_folders_project_path_unique",
    "chats_direct_pair_unique"
  ])
    assert.match(sql, new RegExp(`DROP INDEX "${name}"`));
  for (const table of scoped.map((table) => getTableConfig(table).name))
    assert.match(
      sql,
      new RegExp(
        `CREATE TRIGGER "orchestrat_fill_default_branch_${table}" BEFORE INSERT ON "${table}"`
      ),
      table
    );
});
