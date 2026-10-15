import assert from "node:assert/strict";
import test from "node:test";
import { parseSeedPassword } from "./seed-config.js";

test("seed password must be 10 to 256 characters", () => {
  assert.equal(parseSeedPassword("local dev password"), "local dev password");
  for (const value of [undefined, "", "short", "x".repeat(257)]) {
    assert.throws(() => parseSeedPassword(value));
  }
});
