import { Pool } from "pg";

let pool: Pool | undefined;

function getPool() {
  const connectionString = process.env.WAITLIST_DATABASE_URL;
  if (!connectionString) return;
  // ponytail: one pooled connection per warm instance; increase only if measured concurrency needs it.
  return (pool ??= new Pool({ connectionString, max: 1 }));
}

export const waitlistDatabase = {
  async insert(email: string): Promise<"joined" | "duplicate" | null> {
    const currentPool = getPool();
    if (!currentPool) return null;

    const result = await currentPool.query(
      `insert into orchestrat (email)
       values ($1)
       on conflict (email) do nothing
       returning id`,
      [email]
    );

    return result.rowCount === 1 ? "joined" : "duplicate";
  }
};
