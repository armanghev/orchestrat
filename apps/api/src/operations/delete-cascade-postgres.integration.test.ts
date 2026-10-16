import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createDatabase } from "@orchestrat/db";
import { buildApp } from "../app.js";

// Opt in with ORCHESTRAT_TEST_POSTGRES_URL (a role allowed to create
// databases). Every run creates and drops its own database. pg-mem doesn't
// run the foreign key cascades, so deletes are only proven here.
const postgresUrl = process.env.ORCHESTRAT_TEST_POSTGRES_URL;

test(
  "PostgreSQL deletes projects and organizations that hold agent history",
  { skip: !postgresUrl },
  async (t) => {
    const admin = createDatabase({ connectionString: postgresUrl, max: 1 });
    const name = `orchestrat_test_${randomUUID().replaceAll("-", "")}`;
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(postgresUrl!);
    url.pathname = `/${name}`;
    const { db, pool } = createDatabase({
      connectionString: url.toString(),
      max: 4
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
            authSubject: "postgres-delete-alice",
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
          payload: { name: "Cascade PG" }
        })
      ).json();

      // A project where an agent created a task, commented on it and wrote a
      // document, so its rows name the agent as author and actor.
      const projectWithHistory = async (projectName: string) => {
        const project = (
          await app.inject({
            method: "POST",
            url: `/api/v1/organizations/${organization.id}/projects`,
            headers: alice,
            payload: { name: projectName }
          })
        ).json();
        const agent = (
          await app.inject({
            method: "POST",
            url: `/api/v1/projects/${project.id}/agents`,
            headers: alice,
            payload: { name: `${projectName}-agent` }
          })
        ).json();
        const token = (
          await app.inject({
            method: "POST",
            url: `/api/v1/projects/${project.id}/agents/${agent.id}/credentials`,
            headers: alice
          })
        ).json().token as string;
        const asAgent = async (path: string, payload: object) => {
          const response = await app.inject({
            method: "POST",
            url: `/api/v1/agent${path}`,
            headers: {
              authorization: `Bearer ${token}`,
              "idempotency-key": `pg-delete-${++keys}`
            },
            payload
          });
          assert.ok(response.statusCode < 300, response.body);
          return response.json();
        };
        await asAgent("/sessions", { runtime: "test", integration: "delete" });
        const task = await asAgent("/tasks", { title: "Written by an agent" });
        await asAgent(`/tasks/${task.id}/comments`, {
          body_markdown: "An agent comment"
        });
        await asAgent("/documents", {
          path: "notes/agent.md",
          content: "# Agent notes\n"
        });
        const revisions = await pool.query(
          "SELECT count(*)::int AS count FROM document_revisions WHERE project_id=$1 AND author_agent_id IS NOT NULL",
          [project.id]
        );
        assert.equal(revisions.rows[0].count, 1);
        return project as { id: string; name: string };
      };
      const remaining = async (projectId: string) =>
        (
          await pool.query(
            `SELECT (SELECT count(*) FROM agents WHERE project_id=$1)
                  + (SELECT count(*) FROM tasks WHERE project_id=$1)
                  + (SELECT count(*) FROM document_revisions WHERE project_id=$1)
                  + (SELECT count(*) FROM project_events WHERE project_id=$1)
                  AS count`,
            [projectId]
          )
        ).rows[0].count;

      await t.test("deleting a project removes its agent history", async () => {
        const project = await projectWithHistory("Alpha");
        const response = await app.inject({
          method: "DELETE",
          url: `/api/v1/projects/${project.id}`,
          headers: alice,
          payload: { name: project.name }
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(Number(await remaining(project.id)), 0);
      });

      await t.test(
        "deleting an organization removes its projects' agent history",
        async () => {
          const project = await projectWithHistory("Beta");
          const response = await app.inject({
            method: "DELETE",
            url: `/api/v1/organizations/${organization.id}`,
            headers: alice,
            payload: { name: organization.name }
          });
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(Number(await remaining(project.id)), 0);
          const organizations = await pool.query(
            "SELECT count(*)::int AS count FROM organizations WHERE id=$1",
            [organization.id]
          );
          assert.equal(organizations.rows[0].count, 0);
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
