import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import type { Database } from "./index.js";

// The SQL files ship next to the package: packages/db/drizzle.
export const migrationsFolder = fileURLToPath(
  new URL("../drizzle", import.meta.url)
);

const LOCK = "hashtext('orchestrat_migrations')";

// Applies pending migrations. A session advisory lock keeps two servers
// starting at once from migrating together.
export async function migrateDatabase(db: Database, pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(${LOCK})`);
    try {
      await migrate(db, { migrationsFolder });
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${LOCK})`);
    }
  } finally {
    client.release();
  }
}
