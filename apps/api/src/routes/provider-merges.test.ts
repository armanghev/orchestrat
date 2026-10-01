import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { branchMergeRuns, projectEvents, tasks } from "@orchestrat/db";
import { eq } from "drizzle-orm";
import { connected } from "../test/repository.js";

const key = () => ({ "idempotency-key": randomUUID() });

async function setup() {
  const s = await connected();
  const remote = s.fake.repositories.get(s.repo.id)!;
  const push = async (name: string, sha: string) => {
    remote.branches.set(name, sha);
    await s.deliver("push", { ref: `refs/heads/${name}`, after: sha });
    return (await s.named(name)).find((branch) => !branch.archived_at)!.id;
  };
  const trunk = (await s.named("trunk"))[0]!.id;
  const task = async (title: string) =>
    (await s.alice("POST", `${s.base}/tasks`, { title }, key())).json() as {
      id: string;
    };
  const copyOf = async (lineage: string, branchId: string) =>
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
  // People bring work onto a branch with a manual merge.
  const bring = async (source: string, target: string) => {
    const body = {
      source_branch_id: source,
      target_branch_id: target,
      kind: "merge"
    };
    const preview = (
      await s.alice("POST", `${s.base}/merges/preview`, body)
    ).json().preview;
    const applied = await s.alice(
      "POST",
      `${s.base}/merges`,
      { ...body, preview_fingerprint: preview.fingerprint },
      key()
    );
    assert.equal(applied.statusCode, 201, applied.body);
  };
  let number = 0;
  const merged = (head: string, base: string, extra: object = {}) => ({
    change: {
      number: String(++number),
      headRef: head,
      headSha: remote.branches.get(head) ?? null,
      baseRef: base,
      mergeSha: `merge-${number}`,
      mergedAt: new Date(Date.UTC(2026, 9, 1, 0, number)).toISOString(),
      fromFork: false,
      url: `https://fake.provider.test/acme/app/pull/${number}`,
      ...extra
    }
  });
  const runs = () =>
    s.db
      .select()
      .from(branchMergeRuns)
      .where(eq(branchMergeRuns.trigger, "provider_merge"));
  return {
    ...s,
    remote,
    push,
    trunk,
    task,
    copyOf,
    retitle,
    bring,
    merged,
    runs
  };
}

test("a merged pull request merges the branch; conflicts become decisions", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const clean = await s.task("Only the feature changes this");
  const contested = await s.task("Both change this");
  const feature = await s.push("feat/pr", "sha-pr-1");
  await s.bring(s.trunk, feature);
  await s.retitle((await s.copyOf(clean.id, feature)).id, "Feature's version");
  await s.retitle((await s.copyOf(contested.id, feature)).id, "Feature wins?");
  await s.retitle(contested.id, "Trunk moved too");

  await s.deliver("merged", s.merged("feat/pr", "trunk"));
  const [run] = await s.runs();
  assert.equal(run!.status, "applied_with_decisions");
  assert.equal(run!.providerChangeNumber, "1");
  assert.equal(run!.sourceBranchId, feature);
  assert.equal(run!.targetBranchId, s.trunk);
  assert.equal((await s.copyOf(clean.id, s.trunk)).title, "Feature's version");
  assert.equal(
    (await s.copyOf(contested.id, s.trunk)).title,
    "Trunk moved too",
    "the target is kept"
  );
  const events = await s.db
    .select()
    .from(projectEvents)
    .where(eq(projectEvents.branchId, s.trunk));
  const types = events.map((event) => event.type);
  assert.ok(types.includes("merge.merge_applied"));
  assert.ok(types.includes("decision.opened"));
  const decisions = (
    await s.alice("GET", `${s.base}/decisions?branch_id=${s.trunk}&status=open`)
  ).json().decisions;
  assert.equal(decisions.length, 1, "provider automation never resolves");
});

test("a head deleted before the merge event still merges, once", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const item = await s.task("Shipped");
  const feature = await s.push("feat/gone", "sha-gone-1");
  await s.bring(s.trunk, feature);
  await s.retitle((await s.copyOf(item.id, feature)).id, "Shipped, edited");
  const event = s.merged("feat/gone", "trunk");
  s.remote.branches.delete("feat/gone");
  await s.deliver("push", {
    ref: "refs/heads/feat/gone",
    deleted: true,
    before: "sha-gone-1"
  });
  assert.ok((await s.named("feat/gone"))[0]!.archived_at);

  await s.deliver("merged", event, "merge-delivery");
  await s.deliver("merged", event, "merge-delivery");
  await s.deliver("merged", event, "another-delivery-same-change");
  const runs = await s.runs();
  assert.equal(runs.length, 1, "redeliveries and duplicates are no-ops");
  assert.equal(runs[0]!.sourceBranchId, feature);
  assert.equal((await s.copyOf(item.id, s.trunk)).title, "Shipped, edited");
});

test("a merge the webhooks missed is found by reconcile", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const item = await s.task("Quietly merged");
  const feature = await s.push("feat/quiet", "sha-q-1");
  await s.bring(s.trunk, feature);
  await s.retitle((await s.copyOf(item.id, feature)).id, "Reconciled");
  s.remote.merged.push(s.merged("feat/quiet", "trunk").change);
  assert.equal(
    (await s.alice("POST", `${s.base}/repository/sync`, {})).statusCode,
    202
  );
  await s.worker.tick();
  assert.equal((await s.runs()).length, 1);
  assert.equal((await s.copyOf(item.id, s.trunk)).title, "Reconciled");
  await s.alice("POST", `${s.base}/repository/sync`, {});
  await s.worker.tick();
  assert.equal((await s.runs()).length, 1, "the overlap window is idempotent");
});

test("forks are skipped and unknown heads are recorded as skipped", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  await s.deliver(
    "merged",
    s.merged("someone/fork", "trunk", { fromFork: true })
  );
  assert.equal((await s.runs()).length, 0);
  await s.deliver("merged", s.merged("never-seen", "trunk"));
  const [run] = await s.runs();
  assert.equal(run!.status, "skipped");
  assert.equal(run!.skipReason, "no_source_branch");
});

test("stacked branches merge back without false conflicts", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const item = await s.task("Stacked");
  const first = await s.push("feat/one", "sha-1");
  await s.bring(s.trunk, first);
  const second = await s.push("feat/two", "sha-2");
  await s.bring(first, second);
  await s.retitle(
    (await s.copyOf(item.id, second)).id,
    "From the top of the stack"
  );
  await s.deliver("merged", s.merged("feat/two", "feat/one"));
  await s.deliver("merged", s.merged("feat/one", "trunk"));
  const runs = await s.runs();
  assert.deepEqual(
    runs.map((run) => run.status),
    ["applied", "applied"]
  );
  assert.equal(
    (await s.copyOf(item.id, s.trunk)).title,
    "From the top of the stack"
  );
});
