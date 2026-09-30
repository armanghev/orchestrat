import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as coreSchema from "./schema.js";
import * as branchSchema from "./schema-branches.js";

export * from "./schema.js";
export * from "./schema-branches.js";

const schema = { ...coreSchema, ...branchSchema };

export function createDatabase(config: PoolConfig | Pool) {
  const pool =
    "query" in config ? (config as Pool) : new Pool(config as PoolConfig);
  return { db: drizzle(pool, { schema }), pool };
}

export type Database = ReturnType<typeof createDatabase>["db"];
