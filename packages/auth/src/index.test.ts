import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
  exactBearer,
  generateToken,
  hashPassword,
  hashToken,
  isTokenWithPrefix,
  verifyPassword
} from "./index.js";

// Cheap parameters keep the suite fast; production uses the defaults.
const fast = { logN: 10, r: 8, p: 1 };

test("hashes passwords with a per-password salt and verifies them", async () => {
  const first = await hashPassword("correct horse battery", fast);
  const second = await hashPassword("correct horse battery", fast);
  assert.match(first, /^scrypt\$10\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second, "salts differ");
  assert.deepEqual(await verifyPassword("correct horse battery", first), {
    valid: true,
    needsRehash: true
  });
  assert.equal(
    (await verifyPassword("correct horse batterY", first)).valid,
    false
  );
});

test("current parameters need no rehash", async () => {
  const stored = await hashPassword("a strong passphrase");
  assert.deepEqual(await verifyPassword("a strong passphrase", stored), {
    valid: true,
    needsRehash: false
  });
});

test("normalizes Unicode so equivalent passwords match", async () => {
  const stored = await hashPassword("café-password", fast);
  assert.equal((await verifyPassword("café-password", stored)).valid, true);
});

test("rejects malformed or out-of-range stored hashes", async () => {
  for (const stored of [
    "",
    "bcrypt$10$8$1$c2FsdHNhbHQ$aGFzaA",
    "scrypt$30$8$1$c2FsdHNhbHRzYWx0$aGFzaA",
    "scrypt$15$8$1$c2FsdHNhbHRzYWx0$dG9vc2hvcnQ",
    "scrypt$15$8$1"
  ])
    assert.deepEqual(await verifyPassword("anything", stored), {
      valid: false,
      needsRehash: false
    });
});

test("generates prefixed opaque tokens and hashes them", () => {
  const access = generateToken(ACCESS_TOKEN_PREFIX);
  const refresh = generateToken(REFRESH_TOKEN_PREFIX);
  assert.equal(isTokenWithPrefix(access, ACCESS_TOKEN_PREFIX), true);
  assert.equal(isTokenWithPrefix(refresh, REFRESH_TOKEN_PREFIX), true);
  assert.equal(isTokenWithPrefix(access, REFRESH_TOKEN_PREFIX), false);
  assert.equal(isTokenWithPrefix(`${access}x`, ACCESS_TOKEN_PREFIX), false);
  assert.equal(
    isTokenWithPrefix("orch_sess_short", ACCESS_TOKEN_PREFIX),
    false
  );
  assert.match(hashToken(access), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken(access), hashToken(refresh));
});

test("accepts exactly one well-formed bearer header", () => {
  assert.equal(exactBearer({ authorization: "Bearer abc" }), "abc");
  assert.equal(exactBearer([["Authorization", "Bearer abc"]]), "abc");
  assert.equal(exactBearer({}), null);
  assert.equal(exactBearer({ authorization: "Basic abc" }), null);
  assert.equal(exactBearer({ authorization: "Bearer a b" }), null);
  assert.equal(
    exactBearer([
      ["authorization", "Bearer one"],
      ["Authorization", "Bearer two"]
    ]),
    null
  );
});
