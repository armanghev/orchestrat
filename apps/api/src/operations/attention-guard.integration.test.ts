import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createDatabase } from "@orchestrat/db";
import { buildApp } from "../app.js";

// Opt in with ORCHESTRAT_TEST_POSTGRES_URL (a role allowed to create
// databases). Every run creates and drops its own database.
const postgresUrl = process.env.ORCHESTRAT_TEST_POSTGRES_URL;

test(
  "PostgreSQL comment sequences and the completion guard under concurrency",
  { skip: !postgresUrl },
  async (t) => {
    const admin = createDatabase({ connectionString: postgresUrl, max: 1 });
    const name = `orchestrat_test_${randomUUID().replaceAll("-", "")}`;
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(postgresUrl!);
    url.pathname = `/${name}`;
    const { db, pool } = createDatabase({
      connectionString: url.toString(),
      max: 8
    });
    const app = buildApp({
      allowedOrigins: [],
      db,
      auth: {
        async authenticate(request) {
          const token = [...(request.headers as Iterable<[string, string]>)]
            .find(([key]) => key.toLowerCase() === "authorization")?.[1]
            ?.replace(/^Bearer\s+/, "");
          if (token !== "alice") return null;
          return {
            authSubject: "postgres-attention-alice",
            avatarUrl: null,
            email: "alice@example.com",
            name: "Alice",
            provider: "supabase",
            username: "alice"
          };
        }
      }
    });
    try {
      const migrations = new URL(
        "../../../../packages/db/drizzle/",
        import.meta.url
      );
      for (const file of (await readdir(migrations))
        .filter((value) => value.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(new URL(file, migrations), "utf8"));

      const alice = { authorization: "Bearer alice" };
      let keys = 0;
      const organization = (
        await app.inject({
          method: "POST",
          url: "/api/v1/organizations",
          headers: alice,
          payload: { name: "Attention PG" }
        })
      ).json();
      const project = (
        await app.inject({
          method: "POST",
          url: `/api/v1/organizations/${organization.id}/projects`,
          headers: alice,
          payload: { name: "Guard" }
        })
      ).json();
      const createAgent = async (agentName: string) => {
        const agent = (
          await app.inject({
            method: "POST",
            url: `/api/v1/projects/${project.id}/agents`,
            headers: alice,
            payload: { name: agentName }
          })
        ).json();
        const token = (
          await app.inject({
            method: "POST",
            url: `/api/v1/projects/${project.id}/agents/${agent.id}/credentials`,
            headers: alice
          })
        ).json().token as string;
        const session = (
          await app.inject({
            method: "POST",
            url: "/api/v1/agent/sessions",
            headers: { authorization: `Bearer ${token}` },
            payload: { runtime: "test", integration: agentName }
          })
        ).json().session;
        return {
          id: agent.id as string,
          token,
          sessionId: session.id as string
        };
      };
      const agentA = await createAgent("pg-agent-a");
      const agentB = await createAgent("pg-agent-b");
      const asAgent = (
        agent: { token: string },
        url: string,
        payload: object
      ) =>
        app.inject({
          method: "POST",
          url: `/api/v1/agent${url}`,
          headers: {
            authorization: `Bearer ${agent.token}`,
            "idempotency-key": `pg-attention-${++keys}`
          },
          payload
        });
      const createTask = async (title: string) => {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.id}/tasks`,
          headers: { ...alice, "idempotency-key": `pg-task-${++keys}` },
          payload: { title, status: "ready" }
        });
        assert.equal(response.statusCode, 201, response.body);
        return response.json().id as string;
      };
      const claim = async (taskId: string) => {
        const response = await asAgent(agentA, `/tasks/${taskId}/claim`, {
          session_id: agentA.sessionId,
          lease_seconds: 300
        });
        assert.equal(response.statusCode, 200, response.body);
        return response.json().claim_token as string;
      };
      const complete = (token: string, acknowledgedThrough?: number) =>
        asAgent(agentA, `/sessions/${agentA.sessionId}/claims/complete`, {
          claim_token: token,
          ...(acknowledgedThrough === undefined
            ? {}
            : { acknowledged_through: acknowledgedThrough })
        });

      await t.test("20 concurrent comments get sequences 1..20", async () => {
        const taskId = await createTask("Concurrent comments");
        const responses = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            asAgent(index % 2 ? agentA : agentB, `/tasks/${taskId}/comments`, {
              body_markdown: `comment ${index}`
            })
          )
        );
        for (const response of responses)
          assert.equal(response.statusCode, 201, response.body);
        const sequences = (
          await pool.query(
            "SELECT sequence FROM task_comments WHERE task_id=$1 ORDER BY sequence",
            [taskId]
          )
        ).rows.map((row) => row.sequence);
        assert.deepEqual(
          sequences,
          Array.from({ length: 20 }, (_, index) => index + 1)
        );
      });

      await t.test(
        "a comment racing completion either blocks it or lands after it",
        async () => {
          for (let round = 0; round < 50; round += 1) {
            const taskId = await createTask(`Race ${round}`);
            const token = await claim(taskId);
            const [comment, completion] = await Promise.all([
              asAgent(agentB, `/tasks/${taskId}/comments`, {
                body_markdown: `late news ${round}`
              }),
              complete(token)
            ]);
            assert.equal(comment.statusCode, 201, comment.body);
            const events = (
              await pool.query(
                "SELECT id,type FROM project_events WHERE (type='task.comment_created' AND payload->>'task_id'=$1) OR (type='claim.completed' AND payload->>'task_id'=$1) ORDER BY id",
                [taskId]
              )
            ).rows.map((row) => row.type);
            if (completion.statusCode === 200) {
              // Completion committed first; the comment followed it.
              assert.deepEqual(events, [
                "claim.completed",
                "task.comment_created"
              ]);
              continue;
            }
            assert.equal(completion.statusCode, 409, completion.body);
            assert.equal(completion.json().error.code, "TASK_COMMENTS_UNREAD");
            assert.deepEqual(events, ["task.comment_created"]);
            const retried = await complete(token, comment.json().sequence);
            assert.equal(retried.statusCode, 200, retried.body);
          }
        }
      );

      await t.test("a guard refusal rolls back completely", async () => {
        const taskId = await createTask("Rollback");
        const token = await claim(taskId);
        const posted = await asAgent(agentB, `/tasks/${taskId}/comments`, {
          body_markdown: "blocking comment"
        });
        assert.equal(posted.statusCode, 201, posted.body);
        const snapshot = async () => ({
          claim: (
            await pool.query(
              "SELECT status,completed_at FROM task_claims WHERE task_id=$1",
              [taskId]
            )
          ).rows,
          task: (
            await pool.query("SELECT status,version FROM tasks WHERE id=$1", [
              taskId
            ])
          ).rows,
          watch: (
            await pool.query(
              "SELECT last_read_sequence,claim_baseline_sequence FROM task_watches WHERE task_id=$1 AND agent_id=$2",
              [taskId, agentA.id]
            )
          ).rows,
          events: Number(
            (
              await pool.query(
                "SELECT count(*) AS count FROM project_events WHERE project_id=$1",
                [project.id]
              )
            ).rows[0].count
          )
        });
        const before = await snapshot();
        assert.deepEqual(before.claim, [
          { status: "active", completed_at: null }
        ]);
        assert.equal(before.task[0].status, "claimed");
        for (const acknowledged of [undefined, 0]) {
          const refused = await complete(token, acknowledged);
          assert.equal(refused.statusCode, 409, refused.body);
          assert.equal(refused.json().error.details.total_unread, 1);
        }
        const tooHigh = await complete(token, 2);
        assert.equal(tooHigh.statusCode, 400, tooHigh.body);
        assert.deepEqual(await snapshot(), before);
        const done = await complete(token, 1);
        assert.equal(done.statusCode, 200, done.body);
        const after = await snapshot();
        assert.equal(after.task[0].status, "done");
        assert.equal(after.watch[0].last_read_sequence, 1);
      });
    } finally {
      await app.close();
      await pool.end();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.pool.end();
    }
  }
);
