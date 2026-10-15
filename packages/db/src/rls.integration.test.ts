import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createDatabase } from "./index.js";

const postgresUrl = process.env.ORCHESTRAT_TEST_POSTGRES_URL;
const protectedTables = [
  "document_folders",
  "project_members",
  "project_invitations",
  "chats",
  "chat_participants",
  "chat_messages",
  "task_watches",
  "task_blocks",
  "handoffs",
  "project_branches",
  "branch_merge_runs",
  "branch_item_baselines",
  "branch_merge_decisions",
  "repository_connections",
  "repository_connection_attempts",
  "repository_refs",
  "repository_webhook_deliveries",
  "organization_integrations",
  "organization_repositories",
  "user_passwords",
  "auth_sessions",
  "instance_settings"
] as const;

// Tables without created_at get a harmless self-assignment on another column.
const updateAssignment: Partial<
  Record<(typeof protectedTables)[number], string>
> = {
  document_folders: "\"path\" = 'exposed'",
  chat_participants: '"joined_at" = "joined_at"',
  branch_item_baselines: '"updated_at" = "updated_at"',
  repository_refs: '"last_seen_at" = "last_seen_at"',
  repository_webhook_deliveries: '"received_at" = "received_at"',
  organization_repositories: '"first_seen_at" = "first_seen_at"',
  instance_settings: '"bootstrapped_at" = "bootstrapped_at"'
};

test(
  "new project, messaging, attention and branch tables deny direct roles while preserving owner access",
  { skip: !postgresUrl },
  async () => {
    const admin = createDatabase({ connectionString: postgresUrl, max: 1 });
    const suffix = randomUUID().replaceAll("-", "");
    const databaseName = `orchestrat_rls_${suffix}`;
    const directRole = `orchestrat_direct_${suffix}`;
    let databaseCreated = false;
    let roleCreated = false;
    let pool: ReturnType<typeof createDatabase>["pool"] | undefined;

    try {
      await admin.pool.query(`CREATE ROLE "${directRole}" NOLOGIN`);
      roleCreated = true;
      await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      const url = new URL(postgresUrl!);
      url.pathname = `/${databaseName}`;
      ({ pool } = createDatabase({ connectionString: url.toString(), max: 2 }));

      const migrations = new URL("../drizzle/", import.meta.url);
      const files = (await readdir(migrations))
        .filter((file) => file.endsWith(".sql"))
        .sort();
      for (const file of files)
        await pool.query(await readFile(new URL(file, migrations), "utf8"));

      const userId = randomUUID();
      const secondUserId = randomUUID();
      const organizationId = randomUUID();
      const projectId = randomUUID();
      const chatId = randomUUID();
      const taskId = randomUUID();
      const secondTaskId = randomUUID();
      const defaultBranchId = randomUUID();
      const featureBranchId = randomUUID();
      const runId = randomUUID();
      const connectionId = randomUUID();
      await pool.query(
        `INSERT INTO users (id, auth_subject, auth_provider, name, email)
         VALUES ($1, $2, 'supabase', 'Owner', 'owner@example.com'),
                ($3, $4, 'supabase', 'Member', 'member@example.com')`,
        [userId, `owner-${suffix}`, secondUserId, `member-${suffix}`]
      );
      await pool.query(
        `INSERT INTO organizations (id, name, slug)
         VALUES ($1, 'RLS test', $2)`,
        [organizationId, `rls-${suffix}`]
      );
      await pool.query(
        `INSERT INTO organization_members (organization_id, user_id, role)
         VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
        [organizationId, userId, secondUserId]
      );
      await pool.query(
        `INSERT INTO projects (id, organization_id, name, slug)
         VALUES ($1, $2, 'Private project', $3)`,
        [projectId, organizationId, `private-${suffix}`]
      );
      await pool.query(
        `INSERT INTO project_members (project_id, user_id, role)
         VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
        [projectId, userId, secondUserId]
      );
      // Projects created after 0016 need a default branch; the legacy-style
      // inserts below omit branch_id and exercise the rollout-window shim.
      await pool.query(
        `INSERT INTO project_branches
           (id, project_id, name, is_default, name_source, created_via,
            onboarding_state)
         VALUES ($1, $3, 'main', true, 'fallback', 'dashboard', 'completed'),
                ($2, $3, 'feat/private', false, 'user', 'dashboard', 'pending')`,
        [defaultBranchId, featureBranchId, projectId]
      );
      await pool.query(
        `INSERT INTO document_folders (project_id, path)
         VALUES ($1, 'private')`,
        [projectId]
      );
      await pool.query(
        `INSERT INTO project_invitations
           (project_id, created_by, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 day')`,
        [projectId, userId, `token-${suffix}`]
      );
      await pool.query(
        `INSERT INTO chats
           (id, project_id, kind, name, has_human, creator_type, creator_user_id)
         VALUES ($1, $2, 'group', 'Private chat', true, 'human', $3)`,
        [chatId, projectId, userId]
      );
      await pool.query(
        `INSERT INTO chat_participants (project_id, chat_id, user_id)
         VALUES ($1, $2, $3)`,
        [projectId, chatId, userId]
      );
      const message = await pool.query<{ id: string }>(
        `INSERT INTO chat_messages
           (project_id, chat_id, sequence, author_type, author_user_id,
            author_name, body_markdown)
         VALUES ($1, $2, 1, 'human', $3, 'Owner', 'private message')
         RETURNING id`,
        [projectId, chatId, userId]
      );
      await pool.query(
        `INSERT INTO tasks
           (id, project_id, task_key, task_number, title, created_by_type,
            created_by_user_id)
         VALUES ($1, $3, 'PRJ-1', 1, 'Private task', 'human', $4),
                ($2, $3, 'PRJ-2', 2, 'Second task', 'human', $4)`,
        [taskId, secondTaskId, projectId, userId]
      );
      await pool.query(
        `INSERT INTO task_watches (project_id, task_id, user_id, reason)
         VALUES ($1, $2, $3, 'created')`,
        [projectId, taskId, userId]
      );
      await pool.query(
        `INSERT INTO task_blocks
           (project_id, task_id, created_by_type, created_by_user_id, reason,
            blocking_task_id)
         VALUES ($1, $2, 'human', $3, 'Waiting on PRJ-2', $4)`,
        [projectId, taskId, userId, secondTaskId]
      );
      await pool.query(
        `INSERT INTO handoffs
           (project_id, chat_id, message_id, message_sequence, from_user_id,
            to_user_id, task_id, chain_id)
         VALUES ($1, $2, $3, 1, $4, $5, $6, gen_random_uuid())`,
        [projectId, chatId, message.rows[0]!.id, userId, secondUserId, taskId]
      );
      const [lowBranchId, highBranchId] = [
        defaultBranchId,
        featureBranchId
      ].sort();
      await pool.query(
        `INSERT INTO branch_merge_runs
           (id, project_id, source_branch_id, target_branch_id, kind, trigger,
            status, created_by_type, created_by_user_id)
         VALUES ($1, $2, $3, $4, 'import', 'dashboard', 'applied_with_decisions',
                 'human', $5)`,
        [runId, projectId, featureBranchId, defaultBranchId, userId]
      );
      await pool.query(
        `INSERT INTO branch_item_baselines
           (project_id, branch_low_id, branch_high_id, item_type, lineage_key)
         VALUES ($1, $2, $3, 'task', $4)`,
        [projectId, lowBranchId, highBranchId, taskId]
      );
      await pool.query(
        `INSERT INTO branch_merge_decisions
           (project_id, run_id, source_branch_id, target_branch_id, item_type,
            lineage_key, source_item_id, target_item_id, label, reason)
         VALUES ($1, $2, $3, $4, 'task', $5, $5, $5, 'PRJ-1', 'changed_on_both')`,
        [projectId, runId, featureBranchId, defaultBranchId, taskId]
      );
      await pool.query(
        `INSERT INTO repository_connections
           (id, project_id, provider, provider_repository_id,
            repository_full_name, provider_default_branch,
            access_token_ciphertext)
         VALUES ($1, $2, 'gitlab', '42', 'acme/app', 'main', 'v1.k1.iv.ct')`,
        [connectionId, projectId]
      );
      await pool.query(
        `INSERT INTO repository_connection_attempts
           (id, project_id, user_id, provider, state_hash, expires_at)
         VALUES ($1, $2, $3, 'gitlab', $4, now() + interval '15 minutes')`,
        [`ra_${suffix}`, projectId, userId, `state-${suffix}`]
      );
      await pool.query(
        `INSERT INTO repository_refs
           (project_id, connection_id, name, head_sha, branch_id, created_signal)
         VALUES ($1, $2, 'main', 'abc1234', $3, 'connect_snapshot')`,
        [projectId, connectionId, defaultBranchId]
      );
      const integrationId = randomUUID();
      await pool.query(
        `INSERT INTO organization_integrations
           (id, organization_id, provider, provider_account_id, account_name,
            repository_selection, access_token_ciphertext)
         VALUES ($1, $2, 'gitlab', '7', 'acme', 'all', 'v1.k1.iv.ct')`,
        [integrationId, organizationId]
      );
      await pool.query(
        `INSERT INTO organization_repositories
           (organization_id, integration_id, provider, provider_repository_id,
            full_name)
         VALUES ($1, $2, 'gitlab', '42', 'acme/app')`,
        [organizationId, integrationId]
      );
      await pool.query(
        `INSERT INTO user_passwords (user_id, password_hash)
         VALUES ($1, 'scrypt$15$8$1$salt$hash')`,
        [userId]
      );
      await pool.query(
        `INSERT INTO auth_sessions
           (user_id, access_token_hash, refresh_token_hash,
            access_expires_at, refresh_expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour',
                 now() + interval '30 days')`,
        [userId, `access-${suffix}`, `refresh-${suffix}`]
      );
      await pool.query(
        `INSERT INTO instance_settings (id, bootstrapped_by) VALUES (1, $1)`,
        [userId]
      );
      await pool.query(
        `INSERT INTO repository_webhook_deliveries
           (provider, delivery_id, connection_id, event_type, payload)
         VALUES ('gitlab', $1, $2, 'Push Hook', '{}'::jsonb)`,
        [`delivery-${suffix}`, connectionId]
      );
      const shimmed = await pool.query<{ branch_id: string }>(
        `SELECT DISTINCT branch_id FROM tasks WHERE project_id = $1`,
        [projectId]
      );
      assert.deepEqual(shimmed.rows, [{ branch_id: defaultBranchId }]);

      const rls = await pool.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
         ORDER BY c.relname`,
        [protectedTables]
      );
      assert.deepEqual(
        rls.rows,
        [...protectedTables].sort().map((relname) => ({
          relname,
          relrowsecurity: true,
          relforcerowsecurity: false
        }))
      );

      await pool.query(`GRANT USAGE ON SCHEMA public TO "${directRole}"`);
      await pool.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${protectedTables
          .map((name) => `"${name}"`)
          .join(", ")} TO "${directRole}"`
      );

      const direct = await pool.connect();
      try {
        await direct.query(`SET ROLE "${directRole}"`);
        for (const table of protectedTables) {
          assert.equal(
            (await direct.query(`SELECT * FROM "${table}"`)).rowCount,
            0,
            `${table} must hide rows from direct roles`
          );
          assert.equal(
            (
              await direct.query(
                `UPDATE "${table}" SET ${
                  updateAssignment[table] ?? '"created_at" = "created_at"'
                }`
              )
            ).rowCount,
            0,
            `${table} must not update rows for direct roles`
          );
          assert.equal(
            (await direct.query(`DELETE FROM "${table}"`)).rowCount,
            0,
            `${table} must not delete rows for direct roles`
          );
        }

        const inserts = [
          {
            table: "document_folders",
            sql: `INSERT INTO document_folders (project_id, path) VALUES ($1, 'blocked')`,
            values: [projectId]
          },
          {
            table: "project_members",
            sql: `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'member')`,
            values: [projectId, randomUUID()]
          },
          {
            table: "project_invitations",
            sql: `INSERT INTO project_invitations (project_id, created_by, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`,
            values: [projectId, userId, `blocked-${suffix}`]
          },
          {
            table: "chats",
            sql: `INSERT INTO chats (project_id, kind, name, has_human, creator_type, creator_user_id) VALUES ($1, 'group', 'Blocked', true, 'human', $2)`,
            values: [projectId, userId]
          },
          {
            table: "chat_participants",
            sql: `INSERT INTO chat_participants (project_id, chat_id, user_id) VALUES ($1, $2, $3)`,
            values: [projectId, chatId, secondUserId]
          },
          {
            table: "chat_messages",
            sql: `INSERT INTO chat_messages (project_id, chat_id, sequence, author_type, author_user_id, author_name, body_markdown) VALUES ($1, $2, 2, 'human', $3, 'Owner', 'blocked')`,
            values: [projectId, chatId, userId]
          },
          {
            table: "task_watches",
            sql: `INSERT INTO task_watches (project_id, task_id, user_id, reason) VALUES ($1, $2, $3, 'explicit')`,
            values: [projectId, secondTaskId, secondUserId]
          },
          {
            table: "task_blocks",
            sql: `INSERT INTO task_blocks (project_id, task_id, created_by_type, created_by_user_id, reason) VALUES ($1, $2, 'human', $3, 'blocked')`,
            values: [projectId, secondTaskId, userId]
          },
          {
            table: "handoffs",
            sql: `INSERT INTO handoffs (project_id, chat_id, message_id, message_sequence, from_user_id, to_user_id, chain_id) VALUES ($1, $2, gen_random_uuid(), 1, $3, $4, gen_random_uuid())`,
            values: [projectId, chatId, userId, secondUserId]
          },
          {
            table: "project_branches",
            sql: `INSERT INTO project_branches (project_id, name, name_source, created_via) VALUES ($1, 'blocked', 'user', 'dashboard')`,
            values: [projectId]
          },
          {
            table: "branch_merge_runs",
            sql: `INSERT INTO branch_merge_runs (project_id, source_branch_id, target_branch_id, kind, trigger, status) VALUES ($1, $2, $3, 'merge', 'provider_merge', 'applied')`,
            values: [projectId, featureBranchId, defaultBranchId]
          },
          {
            table: "branch_item_baselines",
            sql: `INSERT INTO branch_item_baselines (project_id, branch_low_id, branch_high_id, item_type, lineage_key) VALUES ($1, $2, $3, 'document', gen_random_uuid())`,
            values: [projectId, lowBranchId, highBranchId]
          },
          {
            table: "branch_merge_decisions",
            sql: `INSERT INTO branch_merge_decisions (project_id, run_id, source_branch_id, target_branch_id, item_type, lineage_key, source_item_id, target_item_id, label, reason) VALUES ($1, $2, $3, $4, 'task', $5, $5, $5, 'blocked', 'changed_on_both')`,
            values: [
              projectId,
              runId,
              featureBranchId,
              defaultBranchId,
              secondTaskId
            ]
          },
          {
            table: "repository_connections",
            sql: `INSERT INTO repository_connections (project_id, provider, provider_repository_id, repository_full_name, provider_default_branch) VALUES ($1, 'github', '7', 'acme/other', 'main')`,
            values: [projectId]
          },
          {
            table: "repository_connection_attempts",
            sql: `INSERT INTO repository_connection_attempts (id, project_id, user_id, provider, state_hash, expires_at) VALUES ($1, $2, $3, 'github', $4, now())`,
            values: [
              `ra_blocked_${suffix}`,
              projectId,
              userId,
              `blocked-${suffix}`
            ]
          },
          {
            table: "repository_refs",
            sql: `INSERT INTO repository_refs (project_id, connection_id, name, created_signal) VALUES ($1, $2, 'blocked', 'event')`,
            values: [projectId, connectionId]
          },
          {
            table: "repository_webhook_deliveries",
            sql: `INSERT INTO repository_webhook_deliveries (provider, delivery_id, event_type, payload) VALUES ('github', $1, 'push', '{}'::jsonb)`,
            values: [`blocked-${suffix}`]
          }
        ];
        for (const insertion of inserts)
          await assert.rejects(
            direct.query(insertion.sql, insertion.values),
            (error: unknown) =>
              error instanceof Error &&
              "code" in error &&
              error.code === "42501",
            `${insertion.table} must reject inserts from direct roles`
          );
      } finally {
        await direct.query("RESET ROLE");
        direct.release();
      }

      for (const table of protectedTables)
        assert.ok(
          Number(
            (await pool.query(`SELECT count(*) FROM "${table}"`)).rows[0].count
          ) > 0,
          `owner must retain access to ${table}`
        );
      const extraFolder = await pool.query<{ id: string }>(
        `INSERT INTO document_folders (project_id, path)
         VALUES ($1, 'owner-write') RETURNING id`,
        [projectId]
      );
      assert.equal(
        (
          await pool.query(
            `UPDATE document_folders SET path = 'owner-updated' WHERE id = $1`,
            [extraFolder.rows[0]!.id]
          )
        ).rowCount,
        1
      );
      assert.equal(
        (
          await pool.query(`DELETE FROM document_folders WHERE id = $1`, [
            extraFolder.rows[0]!.id
          ])
        ).rowCount,
        1
      );
    } finally {
      await pool?.end();
      if (databaseCreated)
        await admin.pool.query(`DROP DATABASE "${databaseName}"`);
      if (roleCreated) await admin.pool.query(`DROP ROLE "${directRole}"`);
      await admin.pool.end();
    }
  }
);
