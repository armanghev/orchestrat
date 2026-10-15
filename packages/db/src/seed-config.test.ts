import assert from "node:assert/strict";
import test from "node:test";
import { EXAMPLE_SEED_PASSWORD, parseSeedPassword } from "./seed-config.js";

test("seed password must be 10 to 256 characters and not the example", () => {
  assert.equal(
    parseSeedPassword("local dev password", {}),
    "local dev password"
  );
  for (const value of [
    undefined,
    "",
    "short",
    "x".repeat(257),
    EXAMPLE_SEED_PASSWORD
  ]) {
    assert.throws(() => parseSeedPassword(value, {}));
  }
});

test("seed refuses to run in production", () => {
  assert.throws(() =>
    parseSeedPassword("local dev password", { NODE_ENV: "production" })
  );
});
