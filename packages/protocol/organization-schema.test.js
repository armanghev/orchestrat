import assert from "node:assert/strict";
import test from "node:test";
import {
  createOrganizationRequestSchema,
  errorCodeSchema,
  slugifyName
} from "./dist/index.js";

test("organization slugs normalize consistently and remain schema-valid", () => {
  for (const [name, expected] of [
    ["  Café & Déjà Vu!  ", "cafe-deja-vu"],
    ["a".repeat(62) + " --- x", "a".repeat(62)],
    ["a".repeat(80), "a".repeat(63)]
  ]) {
    assert.equal(slugifyName(name), expected);
    assert.equal(
      createOrganizationRequestSchema.parse({ name, slug: slugifyName(name) })
        .slug,
      expected
    );
  }
  assert.match(slugifyName("東京"), /^item-[a-f0-9]{8}$/);
  for (const slug of [
    "",
    "Bad Slug",
    "-start",
    "end-",
    "two--hyphens",
    "a".repeat(64)
  ])
    assert.equal(
      createOrganizationRequestSchema.safeParse({ name: "Acme", slug }).success,
      false
    );
  assert.equal(
    errorCodeSchema.parse("ORGANIZATION_SLUG_TAKEN"),
    "ORGANIZATION_SLUG_TAKEN"
  );
});
