import assert from "node:assert/strict";
import test from "node:test";
import { ProjectsApi } from "./index.js";

test("project summaries use the human API path and validate responses", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const api = new ProjectsApi(
    async (method, path, schema, input, retryable) => {
      assert.equal(method, "GET");
      assert.equal(path, `/organizations/${id}/project-summaries`);
      assert.equal(input, undefined);
      assert.equal(retryable, true);
      assert.throws(() => schema.parse({ projects: [{}] }));
      return schema.parse({ projects: [] });
    }
  );
  assert.deepEqual(await api.listProjectSummaries(id), { projects: [] });
  assert.throws(() => api.listProjectSummaries("../invalid"));
});
