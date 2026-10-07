import assert from "node:assert/strict";
import test from "node:test";
import { organizations, organizationMembers } from "@orchestrat/db";
import { apiErrorResponseSchema } from "@orchestrat/protocol";
import { fixture } from "../test/fixture.js";

test("organization creation reports slug conflicts without creating partial membership", async (t) => {
  const { app, db } = await fixture();
  t.after(() => app.close());
  const create = (token: string, payload: object) =>
    app.inject({
      method: "POST",
      url: "/api/v1/organizations",
      headers: { authorization: `Bearer ${token}` },
      payload
    });
  const first = await create("alice", { name: "Café & Déjà Vu!" });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().slug, "cafe-deja-vu");
  for (const token of ["alice", "bob"]) {
    const duplicate = await create(token, {
      name: "Another name",
      slug: "cafe-deja-vu"
    });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    const { error } = apiErrorResponseSchema.parse(duplicate.json());
    assert.equal(error.code, "ORGANIZATION_SLUG_TAKEN");
    assert.equal(error.details.field, "slug");
  }
  assert.equal((await db.select().from(organizations)).length, 1);
  assert.equal((await db.select().from(organizationMembers)).length, 1);
  const custom = await create("bob", {
    name: "Another name",
    slug: "custom-name"
  });
  assert.equal(custom.statusCode, 201, custom.body);
  assert.equal(custom.json().slug, "custom-name");
  assert.equal(
    (await create("alice", { name: "Invalid", slug: "Bad Slug" })).statusCode,
    400
  );
});
