import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  agentSessions,
  projectBranches,
  projectEvents,
  projectMembers,
  taskClaims,
  tasks
} from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
import { workspace } from "../test/workspace.js";

test("new projects start with a default main branch that legacy reads see", async (t) => {
  const { app, project, alice } = await workspace();
  t.after(() => app.close());

  const listed = await alice("GET", `/projects/${project.id}/branches`);
  assert.equal(listed.statusCode, 200, listed.body);
  const [main] = listed.json().branches;
  assert.equal(listed.json().branches.length, 1);
  assert.equal(main.name, "main");
  assert.equal(main.is_default, true);
  assert.equal(main.name_source, "fallback");
  assert.equal(main.onboarding_state, "completed");
  assert.equal(main.provider, null);
  assert.equal(project.default_branch_id, main.id);
  assert.equal(
    (await alice("GET", `/projects/${project.id}`)).json().default_branch_id,
    main.id
  );
});

test("members create branches; names follow git rules and stay unique among active branches", async (t) => {
  const { app, db, project, bob } = await workspace();
  t.after(() => app.close());

  const created = await bob("POST", `/projects/${project.id}/branches`, {
    name: "feat/login"
  });
  assert.equal(created.statusCode, 201, created.body);
  const branch = created.json().branch;
  assert.equal(branch.name, "feat/login");
  assert.equal(branch.is_default, false);
  assert.equal(branch.created_via, "dashboard");
  assert.equal(branch.onboarding_state, "pending");
  assert.equal(branch.created_by.type, "human");

  const duplicate = await bob("POST", `/projects/${project.id}/branches`, {
    name: "feat/login"
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error.code, "BRANCH_NAME_TAKEN");
  for (const name of ["a b", "-x", "x.lock", "a..b", ""])
    assert.equal(
      (await bob("POST", `/projects/${project.id}/branches`, { name }))
        .statusCode,
      400,
      name
    );

  const [event] = await db
    .select()
    .from(projectEvents)
    .where(
      and(
        eq(projectEvents.projectId, project.id),
        eq(projectEvents.type, "branch.created")
      )
    );
  assert.equal(event!.branchId, null, "branch events are project-wide");
  assert.equal(event!.entityId, branch.id);
});

test("only owners and admins archive or change the default", async (t) => {
  const { app, db, project, alice, bob, bobUser } = await workspace();
  t.after(() => app.close());
  const feature = (
    await bob("POST", `/projects/${project.id}/branches`, { name: "feat/a" })
  ).json().branch;

  for (const action of ["default", "archive"]) {
    const denied = await bob(
      "POST",
      `/projects/${project.id}/branches/${feature.id}/${action}`,
      {}
    );
    assert.equal(denied.statusCode, 403, action);
    assert.equal(denied.json().error.code, "PERMISSION_DENIED");
  }

  await db
    .update(projectMembers)
    .set({ role: "admin" })
    .where(
      and(
        eq(projectMembers.projectId, project.id),
        eq(projectMembers.userId, bobUser.id)
      )
    );
  const promoted = await bob(
    "POST",
    `/projects/${project.id}/branches/${feature.id}/default`,
    {}
  );
  assert.equal(promoted.statusCode, 200, promoted.body);
  assert.equal(promoted.json().branch.is_default, true);
  const listed = (await alice("GET", `/projects/${project.id}/branches`)).json()
    .branches;
  assert.deepEqual(
    listed.map((branch: { name: string; is_default: boolean }) => [
      branch.name,
      branch.is_default
    ]),
    [
      ["feat/a", true],
      ["main", false]
    ]
  );
  const defaultArchive = await alice(
    "POST",
    `/projects/${project.id}/branches/${feature.id}/archive`,
    {}
  );
  assert.equal(defaultArchive.statusCode, 409);
  assert.equal(defaultArchive.json().error.details.reason, "default_branch");
});

test("archiving hides the branch, keeps its data, and closes its agent sessions", async (t) => {
  const { app, db, project, alice, bob, createAgent } = await workspace();
  t.after(() => app.close());
  const feature = (
    await bob("POST", `/projects/${project.id}/branches`, { name: "feat/b" })
  ).json().branch;
  const { agent } = await createAgent("codex");
  const sessionId = randomUUID();
  const taskId = randomUUID();
  await db.insert(agentSessions).values({
    id: sessionId,
    projectId: project.id,
    branchId: feature.id,
    agentId: agent.id,
    runtime: "codex",
    integration: "codex"
  });
  await db.insert(tasks).values({
    id: taskId,
    projectId: project.id,
    branchId: feature.id,
    taskKey: "ORC-900",
    taskNumber: 900,
    title: "Branch work",
    status: "claimed",
    createdByType: "agent",
    createdByAgentId: agent.id
  });
  await db.insert(taskClaims).values({
    projectId: project.id,
    branchId: feature.id,
    taskId,
    agentId: agent.id,
    sessionId,
    tokenHash: `hash-${randomUUID()}`,
    leaseExpiresAt: new Date(Date.now() + 60_000)
  });

  const archived = await alice(
    "POST",
    `/projects/${project.id}/branches/${feature.id}/archive`,
    {}
  );
  assert.equal(archived.statusCode, 200, archived.body);
  assert.equal(archived.json().branch.archived_reason, "manual");
  assert.ok(archived.json().branch.archived_at);

  const [session] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId));
  assert.equal(session!.status, "closed");
  const [claim] = await db
    .select()
    .from(taskClaims)
    // Not by task_id: pg-mem answers that from the partial
    // task_claims_one_active_per_task index and hides revoked claims.
    .where(eq(taskClaims.sessionId, sessionId));
  assert.equal(claim!.status, "revoked");
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  assert.equal(task!.status, "ready", "the claim ended, so the task is ready");

  const visible = (await bob("GET", `/projects/${project.id}/branches`)).json()
    .branches;
  assert.deepEqual(
    visible.map((branch: { name: string }) => branch.name),
    ["main"]
  );
  const all = (
    await bob("GET", `/projects/${project.id}/branches?include_archived=true`)
  ).json().branches;
  assert.deepEqual(
    all.map((branch: { name: string }) => branch.name),
    ["main", "feat/b"]
  );
  const again = await alice(
    "POST",
    `/projects/${project.id}/branches/${feature.id}/archive`,
    {}
  );
  assert.equal(again.statusCode, 200, "archiving is idempotent");

  const makeDefault = await alice(
    "POST",
    `/projects/${project.id}/branches/${feature.id}/default`,
    {}
  );
  assert.equal(makeDefault.statusCode, 409);
  assert.equal(makeDefault.json().error.code, "BRANCH_ARCHIVED");
  const reused = await bob("POST", `/projects/${project.id}/branches`, {
    name: "feat/b"
  });
  assert.equal(reused.statusCode, 201, "archived names can be reused");
  assert.notEqual(reused.json().branch.id, feature.id);
});

test("agents register the checkout branch idempotently and never revive a deleted one", async (t) => {
  const { app, db, project, alice, createAgent } = await workspace();
  t.after(() => app.close());
  const { call } = await createAgent("claude");

  const first = await call("POST", "/branches/register", { name: "feat/cli" });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().created, true);
  assert.equal(first.json().branch.created_via, "cli");
  assert.equal(first.json().branch.created_by.type, "agent");
  const second = await call("POST", "/branches/register", { name: "feat/cli" });
  assert.equal(second.json().created, false);
  assert.equal(second.json().branch.id, first.json().branch.id);

  await db
    .update(projectBranches)
    .set({ archivedAt: new Date(), archivedReason: "provider_deleted" })
    .where(eq(projectBranches.id, first.json().branch.id));
  const revived = await call("POST", "/branches/register", {
    name: "feat/cli"
  });
  assert.equal(revived.statusCode, 409);
  assert.equal(revived.json().error.code, "BRANCH_ARCHIVED");
  assert.equal(revived.json().error.details.branch_id, first.json().branch.id);
  const fresh = await call("POST", "/branches/register", {
    name: "feat/cli",
    force_new: true
  });
  assert.equal(fresh.json().created, true);
  assert.notEqual(fresh.json().branch.id, first.json().branch.id);

  const listed = await call("GET", "/branches");
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(
    listed.json().branches.map((branch: { name: string }) => branch.name),
    ["main", "feat/cli"]
  );
  const byName = await call("GET", "/branches?name=feat%2Fcli");
  assert.equal(byName.json().branches[0].id, fresh.json().branch.id);
  const got = await call("GET", `/branches/${fresh.json().branch.id}`);
  assert.equal(got.json().branch.name, "feat/cli");
  const missing = await call("GET", `/branches/${randomUUID()}`);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "BRANCH_NOT_FOUND");

  const project2 = (await alice("GET", `/projects/${project.id}`)).json();
  assert.equal(
    (await call("GET", "/project")).json().default_branch_id,
    project2.default_branch_id
  );
});

test("the CLI-reported default names a fallback default until a repository is connected", async (t) => {
  const { app, project, alice, createAgent } = await workspace();
  t.after(() => app.close());
  const { call } = await createAgent("codex");

  const registered = await call("POST", "/branches/register", {
    name: "master",
    git_default_branch: "master"
  });
  assert.equal(registered.statusCode, 200, registered.body);
  assert.equal(registered.json().created, false, "master is the default now");
  assert.equal(registered.json().branch.is_default, true);
  assert.equal(registered.json().branch.name_source, "cli");

  await call("POST", "/branches/register", {
    name: "feat/y",
    git_default_branch: "trunk"
  });
  const names = (await alice("GET", `/projects/${project.id}/branches`))
    .json()
    .branches.map((branch: { name: string }) => branch.name);
  assert.deepEqual(names, ["master", "feat/y"], "only a fallback name moves");
});

test("branch onboarding records a blank start once", async (t) => {
  const { app, project, bob } = await workspace();
  t.after(() => app.close());
  const branch = (
    await bob("POST", `/projects/${project.id}/branches`, { name: "feat/c" })
  ).json().branch;
  const done = await bob(
    "POST",
    `/projects/${project.id}/branches/${branch.id}/onboarding`,
    { choice: "blank" }
  );
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().branch.onboarding_state, "completed");
  assert.equal(done.json().branch.onboarding_choice, "blank");
  const again = await bob(
    "POST",
    `/projects/${project.id}/branches/${branch.id}/onboarding`,
    { choice: "blank" }
  );
  assert.equal(again.statusCode, 409);
});

test("malformed agent branch headers are rejected before any work", async (t) => {
  const { app, createAgent } = await workspace();
  t.after(() => app.close());
  const { call } = await createAgent("codex");
  const response = await call("GET", "/branches", undefined, {
    "x-orchestrat-branch-id": "not-a-uuid"
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "VALIDATION_ERROR");
  assert.equal(response.json().error.details.header, "x-orchestrat-branch-id");
});

test("other projects' branches are invisible", async (t) => {
  const { app, project, alice, bob, organization } = await workspace();
  t.after(() => app.close());
  const other = (
    await alice("POST", `/organizations/${organization.id}/projects`, {
      name: "Other"
    })
  ).json();
  const otherBranch = (
    await alice("POST", `/projects/${other.id}/branches`, { name: "x" })
  ).json().branch;
  const read = await alice(
    "GET",
    `/projects/${project.id}/branches/${otherBranch.id}`
  );
  assert.equal(read.statusCode, 404);
  const outsider = await bob("GET", `/projects/${other.id}/branches`);
  assert.equal(outsider.statusCode, 403);
});
