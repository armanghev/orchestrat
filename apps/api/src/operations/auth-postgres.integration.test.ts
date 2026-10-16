import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createDatabase, users } from "@orchestrat/db";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";

// Opt in with ORCHESTRAT_TEST_POSTGRES_URL (a role allowed to create
// databases). pg-mem ignores ROLLBACK, so the rollback and race cases of
// built-in auth are covered here against real PostgreSQL.
const postgresUrl = process.env.ORCHESTRAT_TEST_POSTGRES_URL;
const setupToken = "postgres-setup-token-0123456789";
const password = "correct horse battery";

test(
  "PostgreSQL built-in auth: bootstrap race, invite rollback and concurrent refresh",
  { skip: !postgresUrl },
  async () => {
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
      signupMode: "open",
      setupToken
    });
    const signup = (email: string, extra: Record<string, unknown> = {}) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/signup",
        payload: {
          email,
          password,
          full_name: email.split("@")[0],
          setup_token: setupToken,
          ...extra
        }
      });
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    try {
      const migrations = new URL(
        "../../../../packages/db/drizzle/",
        import.meta.url
      );
      for (const file of (await readdir(migrations))
        .filter((value) => value.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(new URL(file, migrations), "utf8"));

      // Concurrent first sign-ups: exactly one becomes the admin.
      const firsts = await Promise.all(
        ["ada", "bea", "cyd", "dov"].map((who) => signup(`${who}@example.com`))
      );
      assert.ok(firsts.every((response) => response.statusCode === 201));
      const admins = firsts.filter(
        (response) => response.json().user.is_instance_admin
      );
      assert.equal(admins.length, 1);
      const owner = admins[0]!.json();

      // A used invite refuses the next sign-up and leaves nothing behind.
      const organization = (
        await app.inject({
          method: "POST",
          url: "/api/v1/organizations",
          headers: bearer(owner.access_token),
          payload: { name: "Acme" }
        })
      ).json();
      const project = (
        await app.inject({
          method: "POST",
          url: `/api/v1/organizations/${organization.id}/projects`,
          headers: bearer(owner.access_token),
          payload: { name: "Rocket" }
        })
      ).json();
      const invite = (
        await app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.id}/invitations`,
          headers: bearer(owner.access_token)
        })
      ).json();
      const [first, second] = await Promise.all([
        signup("eve@example.com", { invite_token: invite.token }),
        signup("fay@example.com", { invite_token: invite.token })
      ]);
      const statuses = [first!.statusCode, second!.statusCode].sort();
      assert.deepEqual(statuses, [201, 403]);
      const loser = first!.statusCode === 403 ? "eve" : "fay";
      const leftovers = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, `${loser}@example.com`));
      assert.equal(leftovers.length, 0, "the refused sign-up rolled back");

      // Two tabs refresh with the same token at once: one rotation wins and
      // the session survives.
      const session = (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { email: owner.user.email, password }
        })
      ).json();
      const refreshes = await Promise.all(
        [0, 1].map(() =>
          app.inject({
            method: "POST",
            url: "/api/v1/auth/refresh",
            payload: { refresh_token: session.refresh_token }
          })
        )
      );
      assert.deepEqual(refreshes.map((r) => r.statusCode).sort(), [200, 401]);
      const winner = refreshes.find((r) => r.statusCode === 200)!.json();
      const profile = await app.inject({
        method: "GET",
        url: "/api/v1/profile",
        headers: bearer(winner.access_token)
      });
      assert.equal(profile.statusCode, 200);
    } finally {
      await app.close();
      await pool.end();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.pool.end();
    }
  }
);
