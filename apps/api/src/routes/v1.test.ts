import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import type { HumanAuth } from "@orchestrat/auth";
import { createDatabase } from "@orchestrat/db";
import { DataType, newDb } from "pg-mem";
import { buildApp } from "../app.js";

const authorization = (subject: string) => ({
  authorization: `Bearer ${subject}`
});

test("Phase 2 API enforces membership and manages projects", async () => {
  const memory = newDb();
  memory.public.registerFunction({
    implementation: randomUUID,
    impure: true,
    name: "gen_random_uuid",
    returns: DataType.uuid
  });
  memory.public.registerFunction({
    args: [DataType.text],
    implementation: (value) => value.trim(),
    name: "btrim",
    returns: DataType.text
  });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  // ponytail: pg-mem lacks pg row mode/type parsers; adapt those two test-only hints.
  const patchClient = (client: any) => {
    const query = client.query.bind(client);
    client.query = async (config: any, ...args: any[]) => {
      if (typeof config !== "object") return query(config, ...args);
      const supported = { ...config };
      const arrayMode = supported.rowMode === "array";
      delete supported.rowMode;
      delete supported.types;
      const result = await query(supported, ...args);
      return arrayMode
        ? {
            ...result,
            rows: result.rows.map((row: object) => Object.values(row))
          }
        : result;
    };
    return client;
  };
  patchClient(pool);
  const connect = pool.connect.bind(pool);
  pool.connect = (async () =>
    patchClient(await connect())) as typeof pool.connect;
  const migrations = new URL(
    "../../../../packages/db/drizzle/",
    import.meta.url
  );
  for (const name of (await readdir(migrations))
    .filter((value) => value.endsWith(".sql"))
    .sort()) {
    const migration = await readFile(new URL(name, migrations), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
    }
  }

  const subjects: Record<string, string> = {
    alice: "550e8400-e29b-41d4-a716-446655440000",
    bob: "9a787b7b-84c1-4d76-83a4-0f76997e5981"
  };
  const auth: HumanAuth = {
    async authenticate(request) {
      const authorization = [
        ...(request.headers as Iterable<[string, string]>)
      ].find(([name]) => name.toLowerCase() === "authorization")?.[1];
      const label = authorization?.replace(/^Bearer\s+/, "");
      const authSubject = label ? subjects[label] : undefined;
      return authSubject
        ? {
            authSubject,
            avatarUrl: null,
            email: `${label}@example.com`,
            name: label!,
            provider: "supabase"
          }
        : null;
    }
  };
  const { db } = createDatabase(
    pool as unknown as Parameters<typeof createDatabase>[0]
  );
  const app = buildApp({ allowedOrigins: [], auth, db });

  try {
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/organizations"
    });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.json().error.code, "UNAUTHENTICATED");
    assert.equal(
      unauthenticated.headers["x-request-id"],
      unauthenticated.json().error.request_id
    );

    const organizationResponse = await app.inject({
      headers: authorization("alice"),
      method: "POST",
      payload: { name: "Acme" },
      url: "/api/v1/organizations"
    });
    assert.equal(organizationResponse.statusCode, 201);
    const organization = organizationResponse.json();
    assert.equal(organization.role, "owner");

    const forbiddenOrganization = await app.inject({
      headers: authorization("bob"),
      method: "GET",
      url: `/api/v1/organizations/${organization.id}`
    });
    assert.equal(forbiddenOrganization.statusCode, 403);
    assert.equal(forbiddenOrganization.json().error.code, "PERMISSION_DENIED");

    const workspaceResponse = await app.inject({
      headers: authorization("alice"),
      method: "POST",
      payload: { name: "Engineering" },
      url: `/api/v1/organizations/${organization.id}/workspaces`
    });
    assert.equal(workspaceResponse.statusCode, 201);
    const workspace = workspaceResponse.json();

    const forbiddenWorkspace = await app.inject({
      headers: authorization("bob"),
      method: "GET",
      url: `/api/v1/workspaces/${workspace.id}`
    });
    assert.equal(forbiddenWorkspace.statusCode, 403);

    const projectResponse = await app.inject({
      headers: authorization("alice"),
      method: "POST",
      payload: { description: "Coordination plane", name: "Orchestrat" },
      url: `/api/v1/workspaces/${workspace.id}/projects`
    });
    assert.equal(projectResponse.statusCode, 201);
    const project = projectResponse.json();
    assert.equal(project.status, "active");
    assert.equal(project.slug, "orchestrat");

    const allowedProject = await app.inject({
      headers: authorization("alice"),
      method: "GET",
      url: `/api/v1/projects/${project.id}`
    });
    assert.equal(allowedProject.statusCode, 200);

    const forbiddenProject = await app.inject({
      headers: authorization("bob"),
      method: "GET",
      url: `/api/v1/projects/${project.id}`
    });
    assert.equal(forbiddenProject.statusCode, 403);

    const archivedProject = await app.inject({
      headers: authorization("alice"),
      method: "POST",
      url: `/api/v1/projects/${project.id}/archive`
    });
    assert.equal(archivedProject.statusCode, 200);
    assert.equal(archivedProject.json().status, "archived");
    assert.ok(archivedProject.json().archived_at);
  } finally {
    await app.close();
    await pool.end();
  }
});
