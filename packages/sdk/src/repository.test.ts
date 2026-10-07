import assert from "node:assert/strict";
import test from "node:test";
import { RepositoryApi } from "./index.js";
import {
  githubInstallationResponseSchema,
  pendingRepositoryAuthorizationResponseSchema
} from "@orchestrat/protocol";

test("provider availability uses a human endpoint and validates responses", async () => {
  const api = new RepositoryApi(
    async (method, path, schema, input, retryable) => {
      assert.equal(method, "GET");
      assert.equal(path, "/repository/providers");
      assert.equal(input, undefined);
      assert.equal(retryable, true);
      assert.throws(() =>
        schema.parse({ providers: [{ provider: "github" }] })
      );
      return schema.parse({ providers: [] });
    }
  );
  assert.deepEqual(await api.listProviders(), { providers: [] });
  assert.deepEqual(
    githubInstallationResponseSchema.parse({ next: "pick_repository" }),
    { next: "pick_repository" }
  );
  for (const return_path of [
    "https://external.test",
    "//external.test",
    "/\\external.test"
  ]) {
    assert.equal(
      githubInstallationResponseSchema.safeParse({
        next: "pick_repository",
        return_path
      }).success,
      false
    );
    assert.equal(
      pendingRepositoryAuthorizationResponseSchema.shape.return_path.safeParse(
        return_path
      ).success,
      false
    );
  }
});
