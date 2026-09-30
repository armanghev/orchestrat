import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createDatabase } from "./index.js";

const postgresUrl = process.env.ORCHESTRAT_TEST_POSTGRES_URL;
const attentionMigration = "0015_agent_attention.sql";

test(
  "0015 numbers existing comments per task and backfills read watches",
  { skip: !postgresUrl },
  async () => {
    const admin = createDatabase({ connectionString: postgresUrl, max: 1 });
    const databaseName = `orchestrat_attention_${randomUUID().replaceAll("-", "")}`;
    let databaseCreated = false;
    let pool: ReturnType<typeof createDatabase>["pool"] | undefined;

    try {
      await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      const url = new URL(postgresUrl!);
      url.pathname = `/${databaseName}`;
      ({ pool } = createDatabase({ connectionString: url.toString(), max: 1 }));

      const migrations = new URL("../drizzle/", import.meta.url);
      const files = (await readdir(migrations))
        .filter((file) => file.endsWith(".sql"))
        .sort();
      assert.ok(files.includes(attentionMigration));
      for (const file of files.filter((file) => file < attentionMigration))
        await pool.query(await readFile(new URL(file, migrations), "utf8"));

      // Seed a database at 0013: a member creator, a former member who
      // created and commented, an agent with an active claim and a released one.
      const member = randomUUID();
      const formerMember = randomUUID();
      const organization = randomUUID();
      const project = randomUUID();
      const agent = randomUUID();
      const session = randomUUID();
      const memberTask = randomUUID();
      const agentTask = randomUUID();
      const orphanTask = randomUUID();
      await pool.query(
        `INSERT INTO users (id, auth_subject, auth_provider, name, email)
         VALUES ($1, 'member', 'supabase', 'Member', 'member@example.com'),
                ($2, 'former', 'supabase', 'Former', 'former@example.com')`,
        [member, formerMember]
      );
      await pool.query(
        `INSERT INTO organizations (id, name, slug) VALUES ($1, 'Org', 'org')`,
        [organization]
      );
      await pool.query(
        `INSERT INTO projects (id, organization_id, name, slug)
         VALUES ($1, $2, 'Project', 'project')`,
        [project, organization]
      );
      await pool.query(
        `INSERT INTO project_members (project_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [project, member]
      );
      await pool.query(
        `INSERT INTO agents (id, project_id, name) VALUES ($1, $2, 'Worker')`,
        [agent, project]
      );
      await pool.query(
        `INSERT INTO agent_sessions (id, project_id, agent_id, runtime, integration)
         VALUES ($1, $2, $3, 'node', 'test')`,
        [session, project, agent]
      );
      await pool.query(
        `INSERT INTO tasks
           (id, project_id, task_key, task_number, title, created_by_type,
            created_by_user_id, created_by_agent_id)
         VALUES ($1, $4, 'PRJ-1', 1, 'Member task', 'human', $5, null),
                ($2, $4, 'PRJ-2', 2, 'Agent task', 'agent', null, $6),
                ($3, $4, 'PRJ-3', 3, 'Orphan task', 'human', $7, null)`,
        [
          memberTask,
          agentTask,
          orphanTask,
          project,
          member,
          agent,
          formerMember
        ]
      );
      await pool.query(
        `INSERT INTO task_claims
           (project_id, task_id, agent_id, session_id, token_hash, status,
            lease_expires_at, released_at, release_reason)
         VALUES ($1, $2, $3, $4, 'active-claim', 'active',
                 now() + interval '1 hour', null, null),
                ($1, $5, $3, $4, 'released-claim', 'released',
                 now() + interval '1 hour', now(), 'done for now')`,
        [project, memberTask, agent, session, orphanTask]
      );
      // Insertion order differs from created_at order; the tie on created_at
      // is broken by id.
      const [tieLow, tieHigh] = [randomUUID(), randomUUID()].sort();
      const comment = (
        id: string,
        task: string,
        authorType: "human" | "agent",
        author: string,
        createdAt: string
      ) =>
        pool!.query(
          `INSERT INTO task_comments
             (id, task_id, project_id, author_type, author_user_id,
              author_agent_id, author_name, body_markdown, created_at)
           VALUES ($1, $2, $3, $4::document_author_type,
                   CASE WHEN $4 = 'human' THEN $5::uuid END,
                   CASE WHEN $4 = 'agent' THEN $5::uuid END,
                   'Author', 'comment', $6)`,
          [id, task, project, authorType, author, createdAt]
        );
      await comment(
        randomUUID(),
        memberTask,
        "human",
        formerMember,
        "2026-01-03T00:00:00Z"
      );
      await comment(
        tieHigh!,
        memberTask,
        "agent",
        agent,
        "2026-01-02T00:00:00Z"
      );
      await comment(
        tieLow!,
        memberTask,
        "human",
        member,
        "2026-01-02T00:00:00Z"
      );
      await comment(
        randomUUID(),
        memberTask,
        "agent",
        agent,
        "2026-01-01T00:00:00Z"
      );
      await comment(
        randomUUID(),
        agentTask,
        "human",
        member,
        "2026-01-01T00:00:00Z"
      );

      await pool.query(
        await readFile(new URL(attentionMigration, migrations), "utf8")
      );

      const sequences = await pool.query<{
        task_id: string;
        id: string;
        sequence: number;
        mentions: unknown;
      }>(
        `SELECT task_id, id, sequence, mentions FROM task_comments
         ORDER BY task_id, created_at, id`
      );
      const byTask = (task: string) =>
        sequences.rows.filter((row) => row.task_id === task);
      assert.deepEqual(
        byTask(memberTask).map((row) => row.sequence),
        [1, 2, 3, 4]
      );
      assert.deepEqual(
        byTask(memberTask)
          .filter((row) => row.id === tieLow || row.id === tieHigh)
          .map((row) => [row.id, row.sequence]),
        [
          [tieLow, 2],
          [tieHigh, 3]
        ]
      );
      assert.deepEqual(
        byTask(agentTask).map((row) => row.sequence),
        [1]
      );
      assert.ok(sequences.rows.every((row) => Array.isArray(row.mentions)));

      const watches = await pool.query<{
        task_id: string;
        actor: string;
        reason: string;
        state: string;
        last_read_sequence: number;
        claim_baseline_sequence: number | null;
      }>(
        `SELECT task_id, coalesce(user_id, agent_id)::text AS actor, reason,
                state, last_read_sequence, claim_baseline_sequence
         FROM task_watches ORDER BY task_id, reason`
      );
      const summary = (task: string) =>
        watches.rows
          .filter((row) => row.task_id === task)
          .map((row) => ({
            actor: row.actor,
            reason: row.reason,
            state: row.state,
            last_read: row.last_read_sequence,
            baseline: row.claim_baseline_sequence
          }))
          .sort((a, b) => a.reason.localeCompare(b.reason));
      // The claimant is watched once, as "claimed", although it also
      // commented. The former member gets no watch (no membership row).
      assert.deepEqual(summary(memberTask), [
        {
          actor: agent,
          reason: "claimed",
          state: "watching",
          last_read: 4,
          baseline: 4
        },
        {
          actor: member,
          reason: "created",
          state: "watching",
          last_read: 4,
          baseline: null
        }
      ]);
      assert.deepEqual(summary(agentTask), [
        {
          actor: member,
          reason: "commented",
          state: "watching",
          last_read: 1,
          baseline: null
        },
        {
          actor: agent,
          reason: "created",
          state: "watching",
          last_read: 1,
          baseline: null
        }
      ]);
      assert.deepEqual(summary(orphanTask), []);

      // New constraints hold after the backfill.
      await assert.rejects(
        comment(
          randomUUID(),
          agentTask,
          "human",
          member,
          "2026-01-05T00:00:00Z"
        ),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "23502"
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO task_comments
             (task_id, project_id, author_type, author_user_id, author_name,
              body_markdown, sequence)
           VALUES ($1, $2, 'human', $3, 'Member', 'duplicate', 1)`,
          [agentTask, project, member]
        ),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "23505"
      );
      const openBlock = `INSERT INTO task_blocks
          (project_id, task_id, created_by_type, created_by_agent_id, reason,
           blocking_task_id)
        VALUES ($1, $2, 'agent', $3, 'Waiting on PRJ-2', $4) RETURNING id`;
      const block = await pool.query<{ id: string }>(openBlock, [
        project,
        memberTask,
        agent,
        agentTask
      ]);
      await assert.rejects(
        pool.query(openBlock, [project, memberTask, agent, agentTask]),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "23505"
      );
      await pool.query(
        `UPDATE task_blocks
         SET resolved_at = now(), resolution = 'blocking_task_done'
         WHERE id = $1`,
        [block.rows[0]!.id]
      );
      await pool.query(openBlock, [project, memberTask, agent, agentTask]);
    } finally {
      await pool?.end();
      if (databaseCreated)
        await admin.pool.query(`DROP DATABASE "${databaseName}"`);
      await admin.pool.end();
    }
  }
);
