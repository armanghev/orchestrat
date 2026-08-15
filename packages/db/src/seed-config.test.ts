import assert from "node:assert/strict";
import test from "node:test";
import { parseSeedAuthSubject } from "./seed-config.js";

test("seed subject must be a Supabase user UUID", () => {
  assert.equal(
    parseSeedAuthSubject("550E8400-E29B-41D4-A716-446655440000"),
    "550e8400-e29b-41d4-a716-446655440000"
  );
  for (const value of [undefined, "", "user_old-provider-id", "not-a-uuid"]) {
    assert.throws(() => parseSeedAuthSubject(value));
  }
});
