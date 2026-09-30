export function isPgMemMigrationStatementSupported(statement: string): boolean {
  if (!statement.trim()) return false;
  if (statement.includes("projects_task_key_prefix_format")) return false;
  if (
    statement.includes(
      "0005 coordination migration requires task_claims to be empty"
    )
  )
    return false;

  // pg-mem has no window functions. The 0015 comment-sequence backfill only
  // numbers pre-existing rows; the real PostgreSQL migration test covers it.
  if (
    /^\s*UPDATE "task_comments" SET "sequence"[\s\S]*\bOVER\s*\(/.test(
      statement
    )
  )
    return false;

  // pg-mem cannot run plpgsql. The 0016 rollout-window shim only fills
  // branch_id for inserts from the pre-branches API; new code always sets it,
  // and the real PostgreSQL acceptance test covers the shim.
  if (statement.includes("orchestrat_fill_default_branch")) return false;

  // pg-mem does not parse PostgreSQL RLS DDL. Production migrations retain it,
  // and the policy behavior is covered by the real PostgreSQL integration test.
  if (
    /^\s*ALTER TABLE\s+.+\s+ENABLE ROW LEVEL SECURITY\s*;?\s*$/i.test(statement)
  )
    return false;

  // pg-mem ignores the WHERE clause of partial indexes, so these would make
  // resolved blocks collide with (or hide behind) the open one on the same
  // task. Real PostgreSQL keeps them; its integration suites cover them.
  if (
    /CREATE (UNIQUE )?INDEX "task_blocks_(one_open_per_task|open_[a-z_]+)"/.test(
      statement
    )
  )
    return false;

  // Same pg-mem limitation for 0016: a lookup such as "branches of project X"
  // would be answered from project_branches_one_default and return only the
  // default. The services check these invariants themselves; the real
  // PostgreSQL suites enforce the indexes.
  if (
    /^\s*CREATE UNIQUE INDEX "[a-z_]+" ON "[a-z_]+" USING btree \([^)]*\) WHERE /.test(
      statement
    ) &&
    /"(project_branches|branch_merge_runs|branch_merge_decisions|repository_connections|repository_connection_attempts|repository_refs)_|_branch_origin_unique"/.test(
      statement
    )
  )
    return false;

  return true;
}
