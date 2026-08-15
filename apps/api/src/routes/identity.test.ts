import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import type { HumanPrincipal } from "@orchestrat/auth";
import { createDatabase, users } from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
import { DataType, newDb } from "pg-mem";
import { IdentityService } from "../services/identity-service.js";

async function testDatabase() {
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

  const directory = new URL(
    "../../../../packages/db/drizzle/",
    import.meta.url
  );
  for (const name of (await readdir(directory))
    .filter((value) => value.endsWith(".sql"))
    .sort()) {
    const migration = await readFile(new URL(name, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
    }
  }

  return {
    ...createDatabase(pool as unknown as Parameters<typeof createDatabase>[0]),
    pool
  };
}

const principal = (
  authSubject: string,
  overrides: Partial<HumanPrincipal> = {}
): HumanPrincipal => ({
  authSubject,
  avatarUrl: null,
  email: "shared@example.com",
  name: "Alice",
  provider: "supabase",
  ...overrides
});

test("provisions once and updates verified profile on repeat login", async () => {
  const { db, pool } = await testDatabase();
  const identities = new IdentityService(db);
  const subject = "550e8400-e29b-41d4-a716-446655440000";
  try {
    const firstId = await identities.resolveUserId(
      principal(subject, {
        email: `${"a".repeat(250)}@example.com`,
        name: null
      })
    );
    const fallback = await db.query.users.findFirst({
      columns: { name: true },
      where: eq(users.id, firstId)
    });
    assert.equal(fallback?.name, "a".repeat(200));

    const secondId = await identities.resolveUserId(
      principal(subject, {
        avatarUrl: "https://cdn.example.com/new.png",
        email: "new@example.com",
        name: "Alice Updated"
      })
    );
    assert.equal(secondId, firstId);
    assert.deepEqual(
      await db.query.users.findFirst({
        columns: {
          authProvider: true,
          avatarUrl: true,
          email: true,
          id: true,
          name: true
        },
        where: and(
          eq(users.authProvider, "supabase"),
          eq(users.authSubject, subject)
        )
      }),
      {
        authProvider: "supabase",
        avatarUrl: "https://cdn.example.com/new.png",
        email: "new@example.com",
        id: firstId,
        name: "Alice Updated"
      }
    );
  } finally {
    await pool.end();
  }
});

test("does not link identities by email and qualifies uniqueness by provider", async () => {
  const { db, pool } = await testDatabase();
  const identities = new IdentityService(db);
  const subject = "550e8400-e29b-41d4-a716-446655440000";
  try {
    const supabaseId = await identities.resolveUserId(principal(subject));
    const otherId = await identities.resolveUserId(
      principal("9a787b7b-84c1-4d76-83a4-0f76997e5981", { name: "Bob" })
    );
    const [legacy] = await db
      .insert(users)
      .values({
        authProvider: "legacy",
        authSubject: subject,
        email: "shared@example.com",
        name: "Legacy"
      })
      .returning({ id: users.id });

    assert.notEqual(otherId, supabaseId);
    assert.notEqual(legacy.id, supabaseId);
    assert.equal((await db.select({ id: users.id }).from(users)).length, 3);
  } finally {
    await pool.end();
  }
});

test("concurrent first logins converge on one local user", async () => {
  const { db, pool } = await testDatabase();
  const identities = new IdentityService(db);
  const value = principal("4a5859d7-6eb2-4eaa-9a22-cba40302998a");
  try {
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => identities.resolveUserId(value))
    );
    assert.equal(new Set(ids).size, 1);
    assert.equal(
      (
        await db
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.authProvider, value.provider),
              eq(users.authSubject, value.authSubject)
            )
          )
      ).length,
      1
    );
  } finally {
    await pool.end();
  }
});
