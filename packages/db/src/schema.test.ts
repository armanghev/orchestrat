import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { users } from "./schema.js";

test("users have provider-qualified identity and non-unique email indexes", () => {
  const config = getTableConfig(users);
  assert.equal(users.authProvider.notNull, true);
  assert.equal(users.authProvider.hasDefault, false);

  const identity = config.indexes.find(
    (index) => index.config.name === "users_auth_provider_subject_unique"
  );
  assert.equal(identity?.config.unique, true);
  assert.deepEqual(
    identity?.config.columns.map((column) =>
      "name" in column ? column.name : undefined
    ),
    ["auth_provider", "auth_subject"]
  );

  const email = config.indexes.find(
    (index) => index.config.name === "users_email_idx"
  );
  assert.equal(email?.config.unique, false);
});

test("identity migration labels legacy rows then removes the default", async () => {
  const directory = new URL("../drizzle/", import.meta.url);
  const migrationName = (await readdir(directory)).find((name) =>
    name.startsWith("0001_")
  );
  assert.ok(migrationName, "expected a 0001 identity migration");
  const sql = await readFile(new URL(migrationName, directory), "utf8");
  assert.match(
    sql,
    /ADD COLUMN "auth_provider" text DEFAULT 'legacy' NOT NULL/
  );
  assert.match(sql, /ALTER COLUMN "auth_provider" DROP DEFAULT/);
  assert.match(sql, /DROP INDEX "users_auth_subject_unique"/);
  assert.match(sql, /DROP INDEX "users_email_unique"/);
  assert.match(
    sql,
    /CREATE UNIQUE INDEX "users_auth_provider_subject_unique".*"auth_provider","auth_subject"/
  );
  assert.match(sql, /CREATE INDEX "users_email_idx".*"email"/);
});
