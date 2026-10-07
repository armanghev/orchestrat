import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createDatabase, projectEvents, tasks } from "@orchestrat/db";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";

// Opt in with ORCHESTRAT_TEST_POSTGRES_URL (a role allowed to create
// databases). Every run creates and drops its own database.
const postgresUrl = process.env.ORCHESTRAT_TEST_POSTGRES_URL;

test(
  "PostgreSQL bulk task writes are ordered and all-or-nothing",
  { skip: !postgresUrl },
  async () => {
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
            authSubject: "postgres-bulk-alice",
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
      const organization = (
        await app.inject({
          method: "POST",
          url: "/api/v1/organizations",
          headers: alice,
          payload: { name: "Bulk PG" }
        })
      ).json();
      const project = (
        await app.inject({
          method: "POST",
          url: `/api/v1/organizations/${organization.id}/projects`,
          headers: alice,
          payload: { name: "Bulk", task_key_prefix: "PG" }
        })
      ).json();
      const agent = (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.id}/agents`,
          headers: alice,
          payload: { name: "pg-bulk" }
        })
      ).json();
      const token = (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.id}/agents/${agent.id}/credentials`,
          headers: alice
        })
      ).json().token as string;
      const asAgent = (
        method: "POST" | "PATCH",
        path: string,
        payload: object,
        key: string
      ) =>
        app.inject({
          method,
          url: `/api/v1/agent${path}`,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
          payload
        });

      // Concurrent batches serialize on the project row: each batch's keys
      // are contiguous and in input order.
      const batches = await Promise.all(
        ["a", "b", "c"].map((label) =>
          asAgent(
            "POST",
            "/tasks/bulk",
            {
              tasks: [1, 2, 3].map((n) => ({ title: `${label}${n}` }))
            },
            `pg-batch-${label}`
          )
        )
      );
      const numbers = batches.map((response) => {
        assert.equal(response.statusCode, 201, response.body);
        return response
          .json()
          .tasks.map((task: { key: string }) => Number(task.key.slice(3)));
      });
      for (const keys of numbers)
        assert.deepEqual(keys, [keys[0], keys[0] + 1, keys[0] + 2]);
      assert.deepEqual(
        numbers.flat().sort((a, b) => a - b),
        [1, 2, 3, 4, 5, 6, 7, 8, 9]
      );
      const replay = await asAgent(
        "POST",
        "/tasks/bulk",
        { tasks: [1, 2, 3].map((n) => ({ title: `a${n}` })) },
        "pg-batch-a"
      );
      assert.deepEqual(replay.json(), batches[0]!.json());

      const [first, second] = batches[0]!.json().tasks as { id: string }[];
      const bumped = await asAgent(
        "PATCH",
        `/tasks/${second!.id}`,
        { priority: "low", expected_version: 1 },
        "unused-1"
      );
      assert.equal(bumped.json().version, 2);
      const eventsBefore = (await db.select().from(projectEvents)).length;
      const stale = await asAgent(
        "PATCH",
        "/tasks/bulk",
        {
          tasks: [
            {
              task_id: first!.id,
              title: "Renamed",
              status: "ready",
              expected_version: 1
            },
            { task_id: second!.id, status: "done", expected_version: 1 }
          ]
        },
        "unused-2"
      );
      assert.equal(stale.statusCode, 409, stale.body);
      assert.equal(stale.json().error.details.index, 1);
      const [row] = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, first!.id));
      assert.equal(row!.title, "a1");
      assert.equal(row!.status, "backlog");
      assert.equal(row!.version, 1);
      assert.equal(
        (await db.select().from(projectEvents)).length,
        eventsBefore
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.pool.end();
    }
  }
);
