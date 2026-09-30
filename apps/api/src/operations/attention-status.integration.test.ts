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
  "PostgreSQL agent status and blocker resolution under concurrency",
  { skip: !postgresUrl },
  async (t) => {
    const admin = createDatabase({ connectionString: postgresUrl, max: 1 });
    const name = `orchestrat_test_${randomUUID().replaceAll("-", "")}`;
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(postgresUrl!);
    url.pathname = `/${name}`;
    const { db, pool } = createDatabase({
      connectionString: url.toString(),
      max: 10
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
            authSubject: "postgres-status-alice",
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
          payload: { name: "Status PG" }
        })
      ).json();
      const project = (
        await app.inject({
          method: "POST",
          url: `/api/v1/organizations/${organization.id}/projects`,
          headers: alice,
          payload: { name: "Status" }
        })
      ).json();
      const openSession = async (token: string, integration: string) =>
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/agent/sessions",
            headers: { authorization: `Bearer ${token}` },
            payload: { runtime: "test", integration }
          })
        ).json().session.id as string;
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
        return {
          id: agent.id as string,
          token,
          sessionId: await openSession(token, agentName)
        };
      };
      type Agent = Awaited<ReturnType<typeof createAgent>>;
      const agentA = await createAgent("pg-status-a");
      const agentB = await createAgent("pg-status-b");
      const agentC = await createAgent("pg-status-c");
      const asAgent = (agent: Agent, path: string, payload?: object) =>
        app.inject({
          method: "POST",
          url: `/api/v1/agent${path}`,
          headers: {
            authorization: `Bearer ${agent.token}`,
            "idempotency-key": `pg-status-${++keys}`
          },
          ...(payload ? { payload } : {})
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
      const claim = async (agent: Agent, taskId: string) => {
        const response = await asAgent(agent, `/tasks/${taskId}/claim`, {
          session_id: agent.sessionId,
          lease_seconds: 300
        });
        assert.equal(response.statusCode, 200, response.body);
        return response.json().claim_token as string;
      };
      const setStatus = (agent: Agent, token: string, body: object) =>
        asAgent(agent, `/sessions/${agent.sessionId}/claims/status`, {
          claim_token: token,
          ...body
        });
      const state = async (taskId: string) => ({
        task: (
          await pool.query("SELECT status FROM tasks WHERE id=$1", [taskId])
        ).rows[0].status as string,
        claims: (
          await pool.query("SELECT status FROM task_claims WHERE task_id=$1", [
            taskId
          ])
        ).rows.map((row) => row.status as string),
        openBlocks: Number(
          (
            await pool.query(
              "SELECT count(*) AS count FROM task_blocks WHERE task_id=$1 AND resolved_at IS NULL",
              [taskId]
            )
          ).rows[0].count
        )
      });

      await t.test(
        "set_task_status racing lease expiry and session close stays consistent",
        async (subtest) => {
          const outcomes = new Map<string, number>();
          for (let round = 0; round < 30; round += 1) {
            const agent = { ...agentA };
            agent.sessionId = await openSession(agent.token, "pg-status-a");
            const taskId = await createTask(`Race ${round}`);
            const token = await claim(agent, taskId);
            const target = round % 2 ? "in_progress" : "blocked";
            // The lease lapses around the time the three requests land; the
            // window varies so each of them wins some rounds.
            await pool.query(
              "UPDATE task_claims SET lease_expires_at=clock_timestamp()+make_interval(secs => $2) WHERE task_id=$1",
              [taskId, [0.005, 0.02, 0.04, 0.08, 0.15][round % 5]]
            );
            const [status, reconcile, close] = await Promise.all([
              setStatus(agent, token, {
                status: target,
                ...(target === "blocked" ? { reason: "racing" } : {})
              }),
              app.inject({
                method: "GET",
                url: `/api/v1/tasks/${taskId}`,
                headers: alice
              }),
              asAgent(agent, `/sessions/${agent.sessionId}/close`)
            ]);
            assert.equal(reconcile.statusCode, 200, reconcile.body);
            assert.equal(close.statusCode, 200, close.body);
            const after = await state(taskId);
            const key = `${target}:${status.statusCode}:${after.claims.join()}`;
            outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
            assert.equal(after.claims.length, 1);
            assert.notEqual(after.claims[0], "active");
            if (status.statusCode !== 200) {
              assert.equal(status.statusCode, 409, status.body);
              assert.match(
                status.json().error.code,
                /^(CLAIM_NOT_FOUND|AGENT_SESSION_CLOSED)$/
              );
            }
            if (target === "blocked" && status.statusCode === 200) {
              // Blocked survives the end of the claim, with its block open.
              assert.deepEqual([after.task, after.openBlocks], ["blocked", 1]);
            } else {
              // No task is left in progress (or claimed) without a claim.
              assert.deepEqual([after.task, after.openBlocks], ["ready", 0]);
            }
          }
          subtest.diagnostic(JSON.stringify(Object.fromEntries(outcomes)));
        }
      );

      await t.test(
        "concurrent triggers resolve one block exactly once",
        async (subtest) => {
          const resolutions = new Map<string, number>();
          // Fresh sessions: the previous subtest can outlast the 60 s
          // heartbeat freshness window.
          agentA.sessionId = await openSession(agentA.token, "pg-status-a");
          agentB.sessionId = await openSession(agentB.token, "pg-status-b");
          for (let round = 0; round < 20; round += 1) {
            const blocker = await createTask(`Blocker ${round}`);
            const blocked = await createTask(`Blocked ${round}`);
            const blockerToken = await claim(agentB, blocker);
            const blockedToken = await claim(agentA, blocked);
            const opened = await setStatus(agentA, blockedToken, {
              status: "blocked",
              reason: "waiting on the blocker",
              blocking_task_id: blocker,
              blocked_on: { type: "agent", id: agentC.id }
            });
            assert.equal(opened.statusCode, 200, opened.body);
            const complete = () =>
              asAgent(agentB, `/sessions/${agentB.sessionId}/claims/complete`, {
                claim_token: blockerToken
              });
            const [first, second, resolve, comment] = await Promise.all([
              complete(),
              complete(),
              app.inject({
                method: "POST",
                url: `/api/v1/tasks/${blocked}/block/resolve`,
                headers: alice
              }),
              asAgent(agentC, `/tasks/${blocked}/comments`, {
                body_markdown: `answer ${round}`
              })
            ]);
            assert.deepEqual(
              [first.statusCode, second.statusCode].sort(),
              [200, 409],
              `${first.body} ${second.body}`
            );
            assert.equal(comment.statusCode, 201, comment.body);
            assert.ok([200, 404].includes(resolve.statusCode), resolve.body);
            const events = (
              await pool.query(
                "SELECT type,payload FROM project_events WHERE entity_id=$1 AND type IN ('task.block_resolved','task.status_changed') ORDER BY id",
                [blocked]
              )
            ).rows;
            const resolved = events.filter(
              (event) => event.type === "task.block_resolved"
            );
            assert.equal(resolved.length, 1, JSON.stringify(events));
            assert.equal(resolved[0].payload.block_id, opened.json().block.id);
            assert.equal(resolved[0].payload.to_status, "in_progress");
            const unblocked = events.filter(
              (event) =>
                event.type === "task.status_changed" &&
                event.payload.from_status === "blocked"
            );
            assert.equal(unblocked.length, 1, JSON.stringify(events));
            const [row] = (
              await pool.query(
                "SELECT resolution FROM task_blocks WHERE task_id=$1",
                [blocked]
              )
            ).rows;
            resolutions.set(
              row.resolution,
              (resolutions.get(row.resolution) ?? 0) + 1
            );
            assert.equal(
              resolve.statusCode === 200,
              row.resolution === "resolved_by_human"
            );
            const after = await state(blocked);
            assert.deepEqual(
              [after.task, after.openBlocks, after.claims],
              ["in_progress", 0, ["active"]]
            );
            const done = await asAgent(
              agentA,
              `/sessions/${agentA.sessionId}/claims/release`,
              {
                claim_token: blockedToken,
                acknowledged_through: comment.json().sequence
              }
            );
            assert.equal(done.statusCode, 200, done.body);
          }
          subtest.diagnostic(JSON.stringify(Object.fromEntries(resolutions)));
          for (const resolution of resolutions.keys())
            assert.match(
              resolution,
              /^(blocking_task_done|resolved_by_human|participant_responded)$/
            );
        }
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.pool.end();
    }
  }
);
