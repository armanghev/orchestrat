import test from "node:test";
import { workspace } from "../test/workspace.js";
import { checkProjectSummaries } from "../test/project-summaries.js";

test("project summaries enforce membership and aggregate default-branch counts without multiplying rows", async (t) => {
  const s = await workspace();
  t.after(() => s.app.close());
  await checkProjectSummaries(s);
});
