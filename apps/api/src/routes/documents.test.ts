import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import type { HumanAuth } from "@orchestrat/auth";
import {
  createDatabase,
  documentRevisions,
  projectEvents
} from "@orchestrat/db";
import { eq } from "drizzle-orm";
import { DataType, newDb } from "pg-mem";
import { buildApp } from "../app.js";
import { isPgMemMigrationStatementSupported } from "../test/pg-mem-migrations.js";

const bearer = (value: string) => ({ authorization: `Bearer ${value}` });

async function fixture() {
  const memory = newDb();
  for (const [name, args, implementation, returns] of [
    ["gen_random_uuid", undefined, randomUUID, DataType.uuid],
    ["btrim", [DataType.text], (value: string) => value.trim(), DataType.text],
    [
      "length",
      [DataType.text],
      (value: string) => value.length,
      DataType.integer
    ],
    [
      "left",
      [DataType.text, DataType.integer],
      (value: string, length: number) => value.slice(0, length),
      DataType.text
    ],
    [
      "regexp_replace",
      [DataType.text, DataType.text, DataType.text, DataType.text],
      (value: string, pattern: string, replacement: string) =>
        value.replace(new RegExp(pattern, "g"), replacement),
      DataType.text
    ]
  ] as const) {
    memory.public.registerFunction({
      name,
      args: args ? [...args] : undefined,
      implementation,
      returns,
      impure: name === "gen_random_uuid"
    });
  }
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
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
      if (isPgMemMigrationStatementSupported(statement))
        await pool.query(statement);
    }
  }
  const subjects = {
    alice: "550e8400-e29b-41d4-a716-446655440000",
    bob: "9a787b7b-84c1-4d76-83a4-0f76997e5981"
  };
  const auth: HumanAuth = {
    async authenticate(request) {
      const value = [...(request.headers as Iterable<[string, string]>)]
        .find(([name]) => name.toLowerCase() === "authorization")?.[1]
        ?.replace(/^Bearer\s+/, "");
      const subject = value
        ? subjects[value as keyof typeof subjects]
        : undefined;
      return subject
        ? {
            authSubject: subject,
            avatarUrl: null,
            email: `${value}@example.com`,
            name: value!,
            provider: "supabase",
            username: value!
          }
        : null;
    }
  };
  const { db } = createDatabase(
    pool as unknown as Parameters<typeof createDatabase>[0]
  );
  return {
    app: buildApp({ allowedOrigins: [], auth, db }),
    db,
    pool,
    subjects
  };
}

test("documents protect revisions, paths, archives, and agent project scope", async () => {
  const { app, db, pool } = await fixture();
  try {
    const organization = (
      await app.inject({
        method: "POST",
        url: "/api/v1/organizations",
        headers: bearer("alice"),
        payload: { name: "Documents" }
      })
    ).json();
    const project = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organization.id}/projects`,
        headers: bearer("alice"),
        payload: { name: "Primary" }
      })
    ).json();
    const other = (
      await app.inject({
        method: "POST",
        url: `/api/v1/organizations/${organization.id}/projects`,
        headers: bearer("alice"),
        payload: { name: "Other" }
      })
    ).json();
    const document = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/documents`,
        headers: bearer("alice"),
        payload: { path: "docs/readme.md", content: "one" }
      })
    ).json();
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/documents/${document.document.id}`,
          headers: bearer("bob")
        })
      ).statusCode,
      403
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/documents/${document.document.id}`,
          headers: bearer("bob"),
          payload: { base_revision: 1, content: "unauthorized" }
        })
      ).statusCode,
      403
    );
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/documents`,
      headers: bearer("alice"),
      payload: { path: "../secret.md", content: "no" }
    });
    assert.equal(invalid.statusCode, 400);
    const invalidExtension = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/documents`,
      headers: bearer("alice"),
      payload: { path: "src/index.ts", content: "no" }
    });
    assert.equal(invalidExtension.statusCode, 400);

    const folder = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/document-folders`,
      headers: bearer("alice"),
      payload: { path: "empty/folder" }
    });
    assert.equal(folder.statusCode, 201);
    assert.equal(folder.json().folder.path, "empty/folder");
    const listedDocuments = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/documents`,
      headers: bearer("alice")
    });
    assert.deepEqual(
      listedDocuments.json().folders.map((item: { path: string }) => item.path),
      ["empty/folder"]
    );

    const updates = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/v1/documents/${document.document.id}`,
        headers: bearer("alice"),
        payload: { base_revision: 1, content: "two-a" }
      }),
      app.inject({
        method: "PATCH",
        url: `/api/v1/documents/${document.document.id}`,
        headers: bearer("alice"),
        payload: { base_revision: 1, content: "two-b" }
      })
    ]);
    assert.equal(
      updates.filter((response) => response.statusCode === 200).length,
      1
    );
    const conflict = updates.find((response) => response.statusCode === 409)!;
    assert.equal(conflict.json().error.code, "DOCUMENT_CONFLICT");
    assert.deepEqual(conflict.json().error.details, {
      current_revision: 2,
      base_revision: 1
    });
    assert.equal((await db.select().from(documentRevisions)).length, 2);
    assert.equal(
      (
        await db
          .select()
          .from(projectEvents)
          .where(eq(projectEvents.type, "document.updated"))
      ).length,
      1
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/documents/${document.document.id}/revisions/1`,
          headers: bearer("alice")
        })
      ).json().revision.content,
      "one"
    );

    const credential = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents`,
        headers: bearer("alice"),
        payload: { name: "writer" }
      })
    ).json();
    const issued = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/agents/${credential.id}/credentials`,
        headers: bearer("alice")
      })
    ).json();
    const agentOther = await app.inject({
      method: "GET",
      url: `/api/v1/agent/documents/${document.document.id}`,
      headers: bearer(issued.token)
    });
    assert.equal(agentOther.statusCode, 200);
    const otherDocument = (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${other.id}/documents`,
        headers: bearer("alice"),
        payload: { path: "other.md", content: "other" }
      })
    ).json();
    const wrongProject = await app.inject({
      method: "GET",
      url: `/api/v1/agent/documents/${otherDocument.document.id}`,
      headers: bearer(issued.token)
    });
    assert.equal(wrongProject.statusCode, 404);
    const wrongProjectWrite = await app.inject({
      method: "PATCH",
      url: `/api/v1/agent/documents/${otherDocument.document.id}`,
      headers: bearer(issued.token),
      payload: { base_revision: 1, content: "cross-project" }
    });
    assert.equal(wrongProjectWrite.statusCode, 404);
    const agentUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/agent/documents/${document.document.id}`,
      headers: bearer(issued.token),
      payload: { base_revision: 2, content: "agent-three" }
    });
    assert.equal(agentUpdate.statusCode, 200);
    assert.equal(agentUpdate.json().revision.revision_number, 3);
    assert.deepEqual(agentUpdate.json().revision.author, {
      type: "agent",
      id: credential.id
    });
    const archived = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/archive`,
      headers: bearer("alice")
    });
    assert.equal(archived.statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/documents/${document.document.id}`,
          headers: bearer("alice")
        })
      ).statusCode,
      200
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/documents/${document.document.id}`,
          headers: bearer("alice"),
          payload: { base_revision: 2, content: "blocked" }
        })
      ).json().error.code,
      "PROJECT_ARCHIVED"
    );
  } finally {
    await app.close();
    await pool.end();
  }
});
