import assert from "node:assert/strict";
import test from "node:test";
import {
  avatarKeySchema,
  profileSchema,
  updateProfileRequestSchema
} from "./dist/index.js";

const key = "AbC_-0123456789abcdefghijklmnopq";
const profile = (avatar_url) => ({
  user_id: "550e8400-e29b-41d4-a716-446655440000",
  provider: "password",
  username: "alice",
  full_name: "Alice",
  email: "alice@example.com",
  avatar_url
});

test("avatar URLs are absolute URLs or the API's root-relative avatar path", () => {
  assert.equal(key.length, 32);
  assert.ok(avatarKeySchema.safeParse(key).success);
  for (const avatar_url of [
    null,
    "https://cdn.example.com/a.png",
    `https://orchestrat.example.com/api/v1/avatars/${key}`,
    `/api/v1/avatars/${key}`
  ]) {
    assert.equal(
      profileSchema.parse(profile(avatar_url)).avatar_url,
      avatar_url
    );
    assert.ok(
      updateProfileRequestSchema.safeParse({
        username: "alice",
        full_name: "Alice",
        avatar_url
      }).success,
      String(avatar_url)
    );
  }
  for (const avatar_url of [
    "avatar.png",
    "/avatar.png",
    `api/v1/avatars/${key}`,
    `//evil.example/api/v1/avatars/${key}`,
    `/api/v1/avatars/${key}?v=1`,
    `/api/v1/avatars/${key}/x`,
    `/api/v1/avatars/${key.slice(1)}`,
    `/api/v1/avatars/${key.slice(1)}.`,
    `/api/v1/avatars/../../${key}`,
    `https://cdn.example.com/${"a".repeat(2048)}`
  ])
    assert.equal(
      profileSchema.safeParse(profile(avatar_url)).success,
      false,
      avatar_url
    );
});
