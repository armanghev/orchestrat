import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  branchItemBaselines,
  branchMergeDecisions,
  branchMergeRuns,
  projectEvents,
  taskComments,
  tasks
} from "@orchestrat/db";
import { and, asc, eq } from "drizzle-orm";
import { workspace } from "../test/workspace.js";
import { AgentService } from "./agent-service.js";
import { BranchService } from "./branch-service.js";
import { MERGE_LIMITS, MergeEngine } from "./merges/engine.js";

const key = () => ({ "idempotency-key": randomUUID() });

async function setup() {
  const s = await workspace();
  const branches = new BranchService(s.db, new AgentService(s.db));
  const engine = new MergeEngine(s.db, branches);
  const feature = (
    await s.alice("POST", `/projects/${s.project.id}/branches`, {
      name: "feat/engine"
    })
  ).json().branch.id as string;
  const main = s.project.default_branch_id as string;
  const task = async (title: string, extra: object = {}, branchId = main) => {
    const created = await s.alice(
      "POST",
      `/projects/${s.project.id}/tasks?branch_id=${branchId}`,
      { title, ...extra },
      key()
    );
    assert.equal(created.statusCode, 201, created.body);
    return created.json() as { id: string; key: string; version: number };
  };
  const rows = (branchId: string) =>
    s.db
      .select()
      .from(tasks)
      .where(eq(tasks.branchId, branchId))
      .orderBy(asc(tasks.taskNumber));
  const copyOf = async (lineage: string, branchId: string) =>
    (await rows(branchId)).find((row) => (row.originId ?? row.id) === lineage)!;
  const edit = async (id: string, input: object) => {
    const [row] = await s.db.select().from(tasks).where(eq(tasks.id, id));
    const response = await s.alice("PATCH", `/tasks/${id}`, {
      ...input,
      expected_version: row!.version
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  const move = async (id: string, status: string) => {
    const [row] = await s.db.select().from(tasks).where(eq(tasks.id, id));
    const response = await s.alice("POST", `/tasks/${id}/move`, {
      status,
      expected_version: row!.version
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  const comment = async (id: string, body: string) => {
    const response = await s.alice(
      "POST",
      `/tasks/${id}/comments`,
      { body_markdown: body },
      key()
    );
    assert.equal(response.statusCode, 201, response.body);
  };
  const depend = async (id: string, blockerId: string) => {
    const [row] = await s.db.select().from(tasks).where(eq(tasks.id, id));
    const response = await s.alice("POST", `/tasks/${id}/dependencies`, {
      depends_on_task_id: blockerId,
      expected_version: row!.version
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  const merge = (sourceBranchId: string, targetBranchId: string) =>
    engine.apply(s.project.id, {
      sourceBranchId,
      targetBranchId,
      kind: "merge",
      trigger: "dashboard",
      userId: s.aliceUser.id
    });
  const importAll = (
    sourceBranchId: string,
    targetBranchId: string,
    extra: object = {}
  ) =>
    engine.apply(s.project.id, {
      sourceBranchId,
      targetBranchId,
      kind: "import",
      selection: { tasks: "all", documents: "all", chats: "all" },
      trigger: "dashboard",
      userId: s.aliceUser.id,
      ...extra
    });
  return {
    ...s,
    engine,
    branches,
    main,
    feature,
    task,
    rows,
    copyOf,
    edit,
    move,
    comment,
    depend,
    merge,
    importAll
  };
}

test("an import copies tasks with their keys, comments and authors", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const original = await s.task("Write the spec", {
    description: "All of it",
    priority: "high"
  });
  await s.comment(original.id, "first");
  await s.comment(original.id, "second");
  await s.task("Not selected");

  const preview = await s.engine.preview(s.project.id, {
    sourceBranchId: s.main,
    targetBranchId: s.feature,
    kind: "import",
    selection: { tasks: [original.id] }
  });
  assert.deepEqual(
    preview.items.map((item) => [item.task_key, item.outcome]),
    [[original.key, "copy"]]
  );
  assert.equal(preview.counts["task_comment.copy"], 2);
  const applied = await s.engine.apply(s.project.id, {
    sourceBranchId: s.main,
    targetBranchId: s.feature,
    kind: "import",
    selection: { tasks: [original.id] },
    trigger: "dashboard",
    userId: s.aliceUser.id,
    previewFingerprint: preview.fingerprint
  });
  assert.equal(applied.status, 201);
  assert.equal(applied.body.run.status, "applied");
  assert.equal(applied.body.run.counts["task.copy"], 1);

  const [copy] = await s.rows(s.feature);
  assert.equal((await s.rows(s.feature)).length, 1);
  assert.equal(copy!.originId, original.id);
  assert.equal(copy!.taskKey, original.key, "keys follow lineage");
  assert.equal(copy!.title, "Write the spec");
  assert.equal(copy!.priority, "high");
  assert.equal(copy!.version, 1);
  assert.equal(copy!.createdByUserId, s.aliceUser.id);
  const comments = await s.db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, copy!.id))
    .orderBy(asc(taskComments.sequence));
  assert.deepEqual(
    comments.map((row) => [row.sequence, row.bodyMarkdown]),
    [
      [1, "first"],
      [2, "second"]
    ]
  );
  assert.ok(comments.every((row) => row.importedAt && row.originId));
  const [sourceComment] = await s.db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, original.id))
    .orderBy(asc(taskComments.sequence));
  assert.equal(comments[0]!.authorName, sourceComment!.authorName);
  assert.equal(comments[0]!.authorUserId, s.aliceUser.id);
  assert.equal(
    comments[0]!.createdAt.getTime(),
    sourceComment!.createdAt.getTime(),
    "original timestamps are kept"
  );

  const events = await s.db
    .select()
    .from(projectEvents)
    .where(eq(projectEvents.branchId, s.feature));
  assert.deepEqual(
    events.map((event) => event.type),
    ["merge.import_applied"],
    "one summary event, no per-item events"
  );
  const again = await s.engine.preview(s.project.id, {
    sourceBranchId: s.main,
    targetBranchId: s.feature,
    kind: "import",
    selection: { tasks: [original.id] }
  });
  assert.equal(again.items[0]!.outcome, "unchanged", "imports are idempotent");
});

test("the three-way rule applies, keeps or conflicts per field", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const applyMe = await s.task("Apply me");
  const keepMe = await s.task("Keep me");
  const both = await s.task("Both changed");
  const same = await s.task("Same change");
  await s.merge(s.main, s.feature);

  await s.edit(applyMe.id, { title: "Applied from main" });
  await s.edit((await s.copyOf(keepMe.id, s.feature)).id, {
    title: "Feature's own"
  });
  await s.edit(both.id, { title: "Main's title" });
  await s.edit((await s.copyOf(both.id, s.feature)).id, {
    title: "Feature's title"
  });
  await s.edit(same.id, { priority: "urgent" });
  await s.edit((await s.copyOf(same.id, s.feature)).id, {
    priority: "urgent"
  });

  const preview = await s.engine.preview(s.project.id, {
    sourceBranchId: s.main,
    targetBranchId: s.feature,
    kind: "merge"
  });
  const outcome = (title: string) =>
    preview.items.find((item) => item.lineage_key === title);
  assert.equal(outcome(applyMe.id)!.outcome, "apply");
  assert.deepEqual(outcome(applyMe.id)!.fields, ["title"]);
  assert.equal(outcome(keepMe.id)!.outcome, "keep_target");
  assert.equal(outcome(both.id)!.outcome, "conflict");
  assert.equal(outcome(both.id)!.reason, "changed_on_both");
  assert.deepEqual(outcome(both.id)!.source_values, { title: "Main's title" });
  assert.deepEqual(outcome(both.id)!.target_values, {
    title: "Feature's title"
  });
  assert.equal(outcome(same.id)!.outcome, "unchanged");

  const run = (await s.merge(s.main, s.feature)).body.run;
  assert.equal(run.status, "applied_with_decisions");
  assert.equal(run.decision_count, 1);
  assert.equal(
    (await s.copyOf(applyMe.id, s.feature)).title,
    "Applied from main"
  );
  assert.equal((await s.copyOf(keepMe.id, s.feature)).title, "Feature's own");
  assert.equal(
    (await s.copyOf(both.id, s.feature)).title,
    "Feature's title",
    "a conflict keeps the target wholesale"
  );
  const [decision] = await s.db.select().from(branchMergeDecisions);
  assert.equal(decision!.status, "open");
  assert.deepEqual(decision!.fields, ["title"]);
  assert.equal(decision!.lineageKey, both.id);

  // The same item conflicting again supersedes the open decision.
  await s.edit(both.id, { title: "Main again" });
  await s.merge(s.main, s.feature);
  const decisions = await s.db
    .select()
    .from(branchMergeDecisions)
    .orderBy(asc(branchMergeDecisions.createdAt));
  assert.deepEqual(decisions.map((row) => row.status).sort(), [
    "open",
    "superseded"
  ]);
  // Baselines remember agreements: only the undecided item comes up again.
  const quiet = await s.engine.preview(s.project.id, {
    sourceBranchId: s.main,
    targetBranchId: s.feature,
    kind: "merge"
  });
  assert.deepEqual(quiet.counts, {
    "task.unchanged": 2,
    "task.keep_target": 1,
    "task.conflict": 1
  });
});

test("imports need a choice per conflict and remember use_target", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const contested = await s.task("Shared");
  await s.importAll(s.main, s.feature);
  await s.edit(contested.id, { title: "Main side" });
  await s.edit((await s.copyOf(contested.id, s.feature)).id, {
    title: "Feature side"
  });
  await assert.rejects(s.importAll(s.main, s.feature), (error: any) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.equal(error.details.reason, "missing_choice");
    assert.deepEqual(error.details.lineage_keys, [contested.id]);
    return true;
  });
  await s.importAll(s.main, s.feature, {
    choices: { [contested.id]: "use_target" }
  });
  assert.equal((await s.copyOf(contested.id, s.feature)).title, "Feature side");
  const after = await s.engine.preview(s.project.id, {
    sourceBranchId: s.main,
    targetBranchId: s.feature,
    kind: "import",
    selection: { tasks: "all" }
  });
  assert.equal(
    after.items[0]!.outcome,
    "keep_target",
    "the same source state never conflicts again"
  );
  assert.equal(
    (await s.db.select().from(branchMergeDecisions)).length,
    0,
    "imports never create decisions"
  );

  await s.edit(contested.id, { title: "Main once more" });
  await s.edit((await s.copyOf(contested.id, s.feature)).id, {
    title: "Feature once more"
  });
  await s.importAll(s.main, s.feature, {
    choices: { [contested.id]: "use_source" }
  });
  assert.equal(
    (await s.copyOf(contested.id, s.feature)).title,
    "Main once more"
  );
});

test("claims never cross branches and claimed targets are never modified", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const working = await s.task("Being worked", { status: "ready" });
  const { call } = await s.createAgent("codex");
  const session = (
    await call("POST", "/sessions", {
      runtime: "codex",
      integration: "codex"
    })
  ).json().session;
  assert.equal(
    (
      await call("POST", `/tasks/${working.id}/claim`, {
        session_id: session.id
      })
    ).statusCode,
    200
  );
  await s.merge(s.main, s.feature);
  const copy = await s.copyOf(working.id, s.feature);
  assert.equal(copy.status, "ready", "a claim-held status copies as ready");

  // The source changes while the target copy is claimed.
  const featureAgent = await s.createAgent("claude");
  const featureSession = (
    await featureAgent.call("POST", "/sessions", {
      runtime: "claude",
      integration: "claude-code",
      branch_id: s.feature
    })
  ).json().session;
  await featureAgent.call("POST", `/tasks/${copy.id}/claim`, {
    session_id: featureSession.id
  });
  await s.db
    .update(tasks)
    .set({ title: "Changed on main" })
    .where(eq(tasks.id, working.id));
  const imported = await s.importAll(s.main, s.feature);
  assert.deepEqual(imported.body.run.skipped, [
    {
      item_type: "task",
      lineage_key: working.id,
      label: "Changed on main",
      reason: "target_claimed"
    }
  ]);
  const merged = await s.merge(s.main, s.feature);
  assert.equal(merged.body.run.decision_count, 1);
  const [decision] = await s.db.select().from(branchMergeDecisions);
  assert.equal(decision!.reason, "target_claimed");
  assert.equal((await s.copyOf(working.id, s.feature)).title, "Being worked");
});

test("a status change lands at the end of its new column", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const first = await s.task("First", { status: "ready" });
  await s.task("Second", { status: "done" });
  await s.merge(s.main, s.feature);
  await s.move(first.id, "done");
  await s.merge(s.main, s.feature);
  const copy = await s.copyOf(first.id, s.feature);
  const done = (await s.rows(s.feature)).filter((row) => row.status === "done");
  assert.equal(copy.status, "done");
  assert.equal(copy.position, Math.max(...done.map((row) => row.position)));
  assert.ok(copy.completedAt, "timestamps follow a manual move");
});

test("comments append after the target's own, without duplicates", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const thread = await s.task("Thread");
  await s.comment(thread.id, "from main 1");
  await s.merge(s.main, s.feature);
  const copy = await s.copyOf(thread.id, s.feature);
  await s.comment(copy.id, "from feature");
  await s.comment(thread.id, "from main 2");
  await s.merge(s.main, s.feature);
  await s.merge(s.main, s.feature);
  const comments = await s.db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, copy.id))
    .orderBy(asc(taskComments.sequence));
  assert.deepEqual(
    comments.map((row) => [
      row.sequence,
      row.bodyMarkdown,
      Boolean(row.importedAt)
    ]),
    [
      [1, "from main 1", true],
      [2, "from feature", false],
      [3, "from main 2", true]
    ]
  );
});

test("imports bring required blockers along and skip edges that close a cycle", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const a = await s.task("A");
  const b = await s.task("B");
  const c = await s.task("C");
  await s.depend(a.id, b.id);
  await s.depend(b.id, c.id);
  const preview = await s.engine.preview(s.project.id, {
    sourceBranchId: s.main,
    targetBranchId: s.feature,
    kind: "import",
    selection: { tasks: [a.id] }
  });
  assert.deepEqual(
    preview.items.map((item) => [item.task_key, item.required_by]),
    [
      [a.key, []],
      [b.key, [a.id]],
      [c.key, [b.id]]
    ]
  );
  assert.equal(preview.counts["task_dependency.copy"], 2);
  await s.importAll(s.main, s.feature);

  // On the feature branch C now depends on A; main adds A → C as well.
  const d = await s.task("D");
  await s.merge(s.main, s.feature);
  await s.depend(
    (await s.copyOf(d.id, s.feature)).id,
    (await s.copyOf(a.id, s.feature)).id
  );
  await s.depend(a.id, d.id);
  const merged = await s.merge(s.main, s.feature);
  assert.deepEqual(merged.body.run.skipped, [
    {
      item_type: "task_dependency",
      lineage_key: a.id,
      label: `${a.key} → ${d.key}`,
      reason: "dependency_cycle"
    }
  ]);
});

test("stacked branches inherit baselines, so merging back has no false conflicts", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const shared = await s.task("Shared");
  await s.merge(s.main, s.feature);
  const stacked = (
    await s.alice("POST", `/projects/${s.project.id}/branches`, {
      name: "feat/stacked"
    })
  ).json().branch.id as string;
  await s.merge(s.feature, stacked);
  const inherited = await s.db
    .select()
    .from(branchItemBaselines)
    .where(eq(branchItemBaselines.lineageKey, shared.id));
  assert.equal(
    inherited.length,
    3,
    "main-feature, feature-stacked, stacked-main"
  );

  await s.edit((await s.copyOf(shared.id, stacked)).id, {
    title: "From the stack"
  });
  const back = await s.engine.preview(s.project.id, {
    sourceBranchId: stacked,
    targetBranchId: s.main,
    kind: "merge"
  });
  assert.deepEqual(
    back.items.map((item) => item.outcome),
    ["apply"]
  );
});

test("apply refuses stale previews, replays keys and dedupes provider runs", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const item = await s.task("Original");
  const request = {
    sourceBranchId: s.main,
    targetBranchId: s.feature,
    kind: "merge" as const
  };
  const preview = await s.engine.preview(s.project.id, request);
  await s.edit(item.id, { title: "Edited after the preview" });
  await assert.rejects(
    s.engine.apply(s.project.id, {
      ...request,
      trigger: "dashboard",
      userId: s.aliceUser.id,
      previewFingerprint: preview.fingerprint
    }),
    (error: any) => {
      assert.equal(error.code, "BRANCH_PREVIEW_STALE");
      assert.notEqual(error.details.preview.fingerprint, preview.fingerprint);
      return true;
    }
  );
  assert.equal((await s.db.select().from(branchMergeRuns)).length, 0);

  const keyed = {
    ...request,
    trigger: "dashboard" as const,
    userId: s.aliceUser.id,
    idempotencyKey: "apply-once"
  };
  const first = await s.engine.apply(s.project.id, keyed);
  const replay = await s.engine.apply(s.project.id, keyed);
  assert.equal(replay.body.run.id, first.body.run.id);
  assert.equal((await s.rows(s.feature)).length, 1);

  const provider = {
    sourceBranchId: s.main,
    targetBranchId: s.feature,
    kind: "merge" as const,
    trigger: "provider_merge" as const,
    userId: null,
    dedupeKey: "github:pr:42",
    provider: { provider: "github" as const, changeNumber: "42" }
  };
  const once = await s.engine.apply(s.project.id, provider);
  const twice = await s.engine.apply(s.project.id, provider);
  assert.equal(twice.body.run.id, once.body.run.id);
  assert.equal(once.body.run.provider?.change_number, "42");
  assert.equal(once.body.run.created_by, null);
});

test("runs can archive the source and finish the target's onboarding", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  await s.task("Seed");
  const run = await s.importAll(s.main, s.feature, {
    completeOnboarding: true
  });
  assert.equal(run.status, 201);
  const feature = (
    await s.alice("GET", `/projects/${s.project.id}/branches/${s.feature}`)
  ).json().branch;
  assert.equal(feature.onboarding_state, "completed");
  assert.equal(feature.onboarding_choice, "import_all");

  await assert.rejects(
    s.engine.apply(s.project.id, {
      sourceBranchId: s.main,
      targetBranchId: s.feature,
      kind: "merge",
      trigger: "dashboard",
      userId: s.aliceUser.id,
      archiveSource: true
    }),
    (error: any) => error.details?.reason === "default_branch"
  );
  await s.engine.apply(s.project.id, {
    sourceBranchId: s.feature,
    targetBranchId: s.main,
    kind: "merge",
    trigger: "dashboard",
    userId: s.aliceUser.id,
    archiveSource: true
  });
  const archived = (
    await s.alice("GET", `/projects/${s.project.id}/branches/${s.feature}`)
  ).json().branch;
  assert.ok(archived.archived_at);
  await assert.rejects(
    s.merge(s.main, s.feature),
    (error: any) => error.code === "BRANCH_ARCHIVED"
  );
  await assert.rejects(
    s.merge(s.main, s.main),
    (error: any) => error.details?.reason === "same_branch"
  );
});

test("runs over the size bounds are refused", async (t) => {
  const s = await setup();
  t.after(() => {
    MERGE_LIMITS.topLevelItems = 2000;
    return s.app.close();
  });
  await s.task("One");
  await s.task("Two");
  MERGE_LIMITS.topLevelItems = 1;
  await assert.rejects(
    s.engine.preview(s.project.id, {
      sourceBranchId: s.main,
      targetBranchId: s.feature,
      kind: "merge"
    }),
    (error: any) => error.details?.reason === "too_large"
  );
  const [decision] = await s.db
    .select()
    .from(branchMergeDecisions)
    .where(and(eq(branchMergeDecisions.status, "open")));
  assert.equal(decision, undefined);
});
