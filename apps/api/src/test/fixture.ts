import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { HumanAuth } from "@orchestrat/auth";
import { createDatabase, type Database } from "@orchestrat/db";
import { DataType, newDb } from "pg-mem";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import type { SignupMode } from "@orchestrat/protocol";
import type { DocumentStorageConfig } from "../services/document-service.js";
import { isPgMemMigrationStatementSupported } from "./pg-mem-migrations.js";

export const TEST_SETUP_TOKEN = "test-setup-token-0123456789";

export async function fixture(
  options: {
    documentStorage?: DocumentStorageConfig;
    repository?: Parameters<typeof buildApp>[0]["repository"];
    trustProxyHops?: number;
    rateLimits?: Parameters<typeof buildApp>[0]["rateLimits"];
    // Use the real session auth instead of the "alice"/"bob" fake.
    builtinAuth?: boolean;
    signupMode?: SignupMode;
    sessionAuth?: Parameters<typeof buildApp>[0]["sessionAuth"];
    setupToken?: string;
  } = {}
): Promise<{
  app: FastifyInstance;
  db: Database;
}> {
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
  memory.public.registerFunction({
    args: [DataType.text],
    implementation: (value) => value.length,
    name: "length",
    returns: DataType.integer
  });
  memory.public.registerFunction({
    args: [DataType.text, DataType.integer],
    implementation: (value, length) => value.slice(0, length),
    name: "left",
    returns: DataType.text
  });
  memory.public.registerFunction({
    args: [DataType.text, DataType.text, DataType.text, DataType.text],
    implementation: (value, pattern, replacement) =>
      value.replace(new RegExp(pattern, "g"), replacement),
    name: "regexp_replace",
    returns: DataType.text
  });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  const patchClient = (client: any) => {
    const query = client.query.bind(client);
    client.query = async (config: any, ...args: any[]) => {
      if (typeof config !== "object") return query(config, ...args);
      const supported = { ...config },
        arrayMode = supported.rowMode === "array";
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
  const auth: HumanAuth = {
    async authenticate(request) {
      const value = [...(request.headers as Iterable<[string, string]>)]
        .find(([name]) => name.toLowerCase() === "authorization")?.[1]
        ?.replace(/^Bearer\s+/, "");
      if (value !== "alice" && value !== "bob") return null;
      return {
        authSubject:
          value === "alice"
            ? "550e8400-e29b-41d4-a716-446655440000"
            : "550e8400-e29b-41d4-a716-446655440001",
        avatarUrl: null,
        email: `${value}@example.com`,
        name: value,
        provider: "supabase",
        username: value
      };
    }
  };
  const { db } = createDatabase(
    pool as unknown as Parameters<typeof createDatabase>[0]
  );
  return {
    app: buildApp({
      allowedOrigins: [],
      auth: options.builtinAuth ? undefined : auth,
      signupMode: options.signupMode,
      sessionAuth: options.sessionAuth,
      setupToken: options.setupToken ?? TEST_SETUP_TOKEN,
      db,
      documentStorage: options.documentStorage,
      repository: options.repository,
      rateLimits: options.rateLimits,
      trustProxyHops: options.trustProxyHops
    }),
    db
  };
}
