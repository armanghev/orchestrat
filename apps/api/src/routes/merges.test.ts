import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  documentRevisions,
  documents,
  projectEvents,
  projectMembers,
  tasks
} from "@orchestrat/db";
import { and, asc, eq } from "drizzle-orm";
import { workspace } from "../test/workspace.js";

const key = () => ({ "idempotency-key": randomUUID() });

async function setup() {
  const s = await workspace();
  const feature = (
    await s.alice("POST", `/projects/${s.project.id}/branches`, {
      name: "feat/routes"
    })
  ).json().branch.id as string;
  const main = s.project.default_branch_id as string;
  const base = `/projects/${s.project.id}`;
  const task = async (title: string) =>
    (await s.alice("POST", `${base}/tasks`, { title }, key())).json() as {
      id: string;
    };
  const copyOf = async (lineage: string, branchId = feature) =>
    (await s.db.select().from(tasks).where(eq(tasks.branchId, branchId))).find(
      (row) => (row.originId ?? row.id) === lineage
    )!;
  const retitle = async (id: string, title: string) => {
    const [row] = await s.db.select().from(tasks).where(eq(tasks.id, id));
    const response = await s.alice("PATCH", `/tasks/${id}`, {
      title,
      expected_version: row!.version
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  const preview = async (body: object, as: typeof s.alice = s.alice) => {
    const response = await as("POST", `${base}/merges/preview`, body);
    assert.equal(response.statusCode, 200, response.body);
    return response.json().preview;
  };
  const apply = async (
    body: Record<string, unknown>,
    as: typeof s.alice = s.alice,
    headers: Record<string, string> = key()
  ) => {
    const fingerprint =
      body.preview_fingerprint ??
      (
        await preview(
          {
            source_branch_id: body.source_branch_id,
            target_branch_id: body.target_branch_id,
            kind: body.kind,
            ...(body.selection ? { selection: body.selection } : {})
          },
          as
        )
      ).fingerprint;
    return as(
      "POST",
      `${base}/merges`,
      { ...body, preview_fingerprint: fingerprint },
      headers
    );
  };
  const mergeInto = (source: string, target: string) =>
    apply({
      source_branch_id: source,
      target_branch_id: target,
      kind: "merge"
    });
  // Changes one task on both sides so the next merge opens a decision.
  const conflict = async () => {
    const item = await task("Contested");
    assert.equal((await mergeInto(main, feature)).statusCode, 201);
    await retitle(item.id, "Main's title");
    await retitle((await copyOf(item.id)).id, "Feature's title");
    const merged = await mergeInto(main, feature);
    assert.equal(merged.json().run.decision_count, 1, merged.body);
    const [decision] = (
      await s.alice("GET", `${base}/decisions?branch_id=${feature}&status=open`)
    ).json().decisions;
    return { item, decision };
  };
  return {
    ...s,
    main,
    feature,
    base,
    task,
    copyOf,
    retitle,
    preview,
    apply,
    mergeInto,
    conflict
  };
}

test("members import into working branches; owners and admins merge", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  await s.task("Seed");
  const importInto = (target: string) => ({
    source_branch_id: target === s.main ? s.feature : s.main,
    target_branch_id: target,
    kind: "import",
    selection: { tasks: "all", documents: "all", chats: "all" }
  });
  const imported = await s.apply(importInto(s.feature), s.bob);
  assert.equal(imported.statusCode, 201, imported.body);
  for (const body of [
    importInto(s.main),
    { ...importInto(s.feature), archive_source: true },
    { source_branch_id: s.main, target_branch_id: s.feature, kind: "merge" }
  ]) {
    const denied = await s.apply(body as Record<string, unknown>, s.bob);
    assert.equal(denied.statusCode, 403, JSON.stringify(body));
  }
  await s.db
    .update(projectMembers)
    .set({ role: "admin" })
    .where(
      and(
        eq(projectMembers.projectId, s.project.id),
        eq(projectMembers.userId, s.bobUser.id)
      )
    );
  assert.equal((await s.mergeInto(s.main, s.feature)).statusCode, 201);
  const missingKey = await s.alice("POST", `${s.base}/merges`, {
    source_branch_id: s.main,
    target_branch_id: s.feature,
    kind: "merge",
    preview_fingerprint: "0".repeat(64)
  });
  assert.equal(missingKey.statusCode, 400);
  const agent = await s.createAgent("codex");
  assert.equal(
    (await agent.call("POST", `${s.base}/merges/preview`, {})).statusCode,
    404,
    "agents have no merge routes"
  );
});

test("stale previews are refused and a lost response replays", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const item = await s.task("Original");
  const body = {
    source_branch_id: s.main,
    target_branch_id: s.feature,
    kind: "merge"
  };
  const preview = await s.preview(body);
  await s.retitle(item.id, "Edited");
  const stale = await s.apply({
    ...body,
    preview_fingerprint: preview.fingerprint
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "BRANCH_PREVIEW_STALE");
  const fresh = stale.json().error.details.preview;
  assert.equal(fresh.items[0].label, "Edited");

  const once = key();
  const first = await s.apply(
    { ...body, preview_fingerprint: fresh.fingerprint },
    s.alice,
    once
  );
  const again = await s.apply(
    { ...body, preview_fingerprint: fresh.fingerprint },
    s.alice,
    once
  );
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(again.statusCode, 201);
  assert.equal(again.json().run.id, first.json().run.id);

  const runs = await s.alice(
    "GET",
    `${s.base}/merges?branch_id=${s.feature}&limit=1`
  );
  assert.equal(runs.json().runs.length, 1);
  assert.equal(runs.json().runs[0].id, first.json().run.id);
});

test("imports need a choice for every conflict", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const item = await s.task("Shared");
  await s.mergeInto(s.main, s.feature);
  await s.retitle(item.id, "Main");
  await s.retitle((await s.copyOf(item.id)).id, "Feature");
  const body = {
    source_branch_id: s.main,
    target_branch_id: s.feature,
    kind: "import",
    selection: { tasks: [item.id] }
  };
  const missing = await s.apply(body);
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error.details.reason, "missing_choice");
  const chosen = await s.apply({
    ...body,
    choices: { [item.id]: "use_source" }
  });
  assert.equal(chosen.statusCode, 201, chosen.body);
  assert.equal((await s.copyOf(item.id)).title, "Main");
});

test("owners settle decisions: use_target remembers, use_source applies", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const { item, decision } = await s.conflict();
  assert.equal(decision.reason, "changed_on_both");
  assert.deepEqual(decision.source_values.title, "Main's title");
  const branch = (
    await s.alice("GET", `${s.base}/branches/${s.feature}`)
  ).json().branch;
  assert.equal(branch.open_decision_count, 1);

  const resolve = (id: string, choice: string, as: typeof s.alice = s.alice) =>
    as("POST", `${s.base}/decisions/${id}/resolve`, { choice });
  assert.equal(
    (await resolve(decision.id, "use_source", s.bob)).statusCode,
    403
  );
  const settled = await resolve(decision.id, "use_source");
  assert.equal(settled.statusCode, 200, settled.body);
  assert.equal(settled.json().decision.status, "resolved_source");
  assert.equal((await s.copyOf(item.id)).title, "Main's title");
  const again = await resolve(decision.id, "use_target");
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error.details.reason, "decision_closed");
  const events = await s.db
    .select()
    .from(projectEvents)
    .where(eq(projectEvents.branchId, s.feature));
  assert.ok(
    events.some(
      (event) =>
        event.type === "task.updated" &&
        (event.payload as { decision_id?: string }).decision_id === decision.id
    ),
    "the applied change says which decision made it"
  );
  assert.ok(events.some((event) => event.type === "decision.resolved"));
  assert.equal(
    (await s.alice("GET", `${s.base}/branches/${s.feature}`)).json().branch
      .open_decision_count,
    0
  );

  // use_target keeps the target, and the same source state stops conflicting.
  await s.retitle(item.id, "Main, later");
  await s.retitle((await s.copyOf(item.id)).id, "Feature, later");
  await s.mergeInto(s.main, s.feature);
  const [second] = (
    await s.alice("GET", `${s.base}/decisions?status=open`)
  ).json().decisions;
  assert.equal((await resolve(second.id, "use_target")).statusCode, 200);
  assert.equal((await s.copyOf(item.id)).title, "Feature, later");
  const quiet = await s.preview({
    source_branch_id: s.main,
    target_branch_id: s.feature,
    kind: "merge"
  });
  assert.equal(quiet.items[0].outcome, "keep_target");
});

test("a decision whose target moved is refreshed, or settles itself", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const { item, decision } = await s.conflict();
  await s.retitle((await s.copyOf(item.id)).id, "Feature moved on");
  const stale = await s.alice(
    "POST",
    `${s.base}/decisions/${decision.id}/resolve`,
    { choice: "use_source" }
  );
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "BRANCH_DECISION_STALE");
  assert.equal(
    stale.json().error.details.decision.target_values.title,
    "Feature moved on"
  );
  const retried = await s.alice(
    "POST",
    `${s.base}/decisions/${decision.id}/resolve`,
    { choice: "use_source" }
  );
  assert.equal(retried.statusCode, 200, "the refresh was saved");
  assert.equal((await s.copyOf(item.id)).title, "Main's title");

  const next = await s.conflict();
  await s.retitle((await s.copyOf(next.item.id)).id, "Main's title");
  const auto = await s.alice(
    "POST",
    `${s.base}/decisions/${next.decision.id}/resolve`,
    { choice: "use_source" }
  );
  assert.equal(auto.statusCode, 200);
  assert.equal(auto.json().decision.status, "resolved_source");
});

test("a claimed target waits for its claim before use_source", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const { item, decision } = await s.conflict();
  const copy = await s.copyOf(item.id);
  await s.db
    .update(tasks)
    .set({ status: "ready" })
    .where(eq(tasks.id, copy.id));
  const { call } = await s.createAgent("codex");
  const session = (
    await call("POST", "/sessions", {
      runtime: "codex",
      integration: "codex",
      branch_id: s.feature
    })
  ).json().session;
  const claimed = await call("POST", `/tasks/${copy.id}/claim`, {
    session_id: session.id
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const refused = await s.alice(
    "POST",
    `${s.base}/decisions/${decision.id}/resolve`,
    { choice: "use_source" }
  );
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error.code, "TASK_ALREADY_CLAIMED");
});

test("document decisions apply the recorded source revision", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const created = (
    await s.alice("POST", `${s.base}/documents`, {
      path: "plan.md",
      content: "base"
    })
  ).json().document;
  await s.mergeInto(s.main, s.feature);
  const [copy] = await s.db
    .select()
    .from(documents)
    .where(eq(documents.branchId, s.feature));
  const write = async (id: string, content: string, revision: number) =>
    s.alice("PATCH", `/documents/${id}`, { content, base_revision: revision });
  await write(created.id, "main's text", 1);
  await write(copy!.id, "feature's text", 1);
  await s.mergeInto(s.main, s.feature);
  const [decision] = (
    await s.alice("GET", `${s.base}/decisions?status=open`)
  ).json().decisions;
  assert.equal(decision.item_type, "document");
  assert.deepEqual(decision.fields, ["body"]);
  const settled = await s.alice(
    "POST",
    `${s.base}/decisions/${decision.id}/resolve`,
    { choice: "use_source" }
  );
  assert.equal(settled.statusCode, 200, settled.body);
  const history = await s.db
    .select()
    .from(documentRevisions)
    .where(eq(documentRevisions.documentId, copy!.id))
    .orderBy(asc(documentRevisions.revisionNumber));
  assert.deepEqual(
    history.map((revision) => revision.contentMarkdown),
    ["base", "feature's text", "main's text"]
  );
});
