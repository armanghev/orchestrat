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
  "chat_messages"
] as const;

test(
  "new project and messaging tables deny direct roles while preserving owner access",
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
      await pool.query(
        `INSERT INTO chat_messages
           (project_id, chat_id, sequence, author_type, author_user_id,
            author_name, body_markdown)
         VALUES ($1, $2, 1, 'human', $3, 'Owner', 'private message')`,
        [projectId, chatId, userId]
      );

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
                  table === "document_folders"
                    ? "\"path\" = 'exposed'"
                    : table === "chat_participants"
                      ? '"joined_at" = "joined_at"'
                      : '"created_at" = "created_at"'
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
