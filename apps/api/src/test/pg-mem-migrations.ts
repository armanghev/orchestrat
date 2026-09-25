export function isPgMemMigrationStatementSupported(statement: string): boolean {
  if (!statement.trim()) return false;
  if (statement.includes("projects_task_key_prefix_format")) return false;
  if (
    statement.includes(
      "0005 coordination migration requires task_claims to be empty"
    )
  )
    return false;

  // pg-mem does not parse PostgreSQL RLS DDL. Production migrations retain it,
  // and the policy behavior is covered by the real PostgreSQL integration test.
  if (
    /^\s*ALTER TABLE\s+.+\s+ENABLE ROW LEVEL SECURITY\s*;?\s*$/i.test(statement)
  )
    return false;

  return true;
}
