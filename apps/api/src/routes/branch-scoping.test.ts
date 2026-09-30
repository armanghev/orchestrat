import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  agentSessions,
  apiIdempotencyKeys,
  projectMembers,
  tasks
} from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
import { workspace } from "../test/workspace.js";

const key = () => ({ "idempotency-key": randomUUID() });

async function twoBranches() {
  const space = await workspace();
  const feature = (
    await space.alice("POST", `/projects/${space.project.id}/branches`, {
      name: "feat/scope"
    })
  ).json().branch;
  return {
    ...space,
    main: space.project.default_branch_id as string,
    feature: feature.id as string
  };
}

test("tasks live on one branch; legacy requests use the default", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const onMain = await s.alice(
    "POST",
    `/projects/${s.project.id}/tasks`,
    { title: "Main work" },
    key()
  );
  assert.equal(onMain.statusCode, 201, onMain.body);
  assert.equal(onMain.json().branch_id, s.main);
  const onFeature = await s.alice(
    "POST",
    `/projects/${s.project.id}/tasks?branch_id=${s.feature}`,
    { title: "Feature work" },
    key()
  );
  assert.equal(onFeature.json().branch_id, s.feature);
  assert.deepEqual(
    [onMain.json().key, onFeature.json().key],
    ["ORC-1", "ORC-2"],
    "fresh task numbers stay unique across branches"
  );
  const titles = async (query: string) =>
    (await s.alice("GET", `/projects/${s.project.id}/tasks${query}`))
      .json()
      .tasks.map((task: { title: string }) => task.title);
  assert.deepEqual(await titles(""), ["Main work"]);
  assert.deepEqual(await titles(`?branch_id=${s.feature}`), ["Feature work"]);
  const unknown = await s.alice(
    "GET",
    `/projects/${s.project.id}/tasks?branch_id=${randomUUID()}`
  );
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error.code, "BRANCH_NOT_FOUND");
});

test("agents pick a branch by header, and a pinned session wins", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const { call } = await s.createAgent("codex");
  const branchHeader = { "x-orchestrat-branch-id": s.feature };
  const created = await call(
    "POST",
    "/tasks",
    { title: "Agent feature task" },
    { ...branchHeader, ...key() }
  );
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().branch_id, s.feature);
  const listed = await call("GET", "/tasks", undefined, branchHeader);
  assert.deepEqual(
    listed.json().tasks.map((task: { title: string }) => task.title),
    ["Agent feature task"]
  );
  assert.equal((await call("GET", "/tasks")).json().tasks.length, 0);

  const session = (
    await call("POST", "/sessions", {
      runtime: "codex",
      integration: "codex",
      branch_id: s.feature
    })
  ).json().session;
  assert.equal(session.branch_id, s.feature);
  const pinned = { "x-orchestrat-session-id": session.id };
  assert.equal(
    (await call("GET", "/tasks", undefined, pinned)).json().tasks.length,
    1
  );
  const override = await call("GET", "/tasks", undefined, {
    ...pinned,
    "x-orchestrat-branch-id": s.main
  });
  assert.equal(override.statusCode, 409);
  assert.equal(override.json().error.code, "BRANCH_MISMATCH");

  const mainTask = (
    await s.alice(
      "POST",
      `/projects/${s.project.id}/tasks`,
      { title: "Main only" },
      key()
    )
  ).json();
  const read = await call("GET", `/tasks/${mainTask.id}`, undefined, pinned);
  assert.equal(read.statusCode, 200, "reads across branches are allowed");
  const write = await call(
    "PATCH",
    `/tasks/${mainTask.id}`,
    { title: "Hijacked", expected_version: 1 },
    pinned
  );
  assert.equal(write.statusCode, 409);
  assert.equal(write.json().error.code, "BRANCH_MISMATCH");
  const comment = await call(
    "POST",
    `/tasks/${mainTask.id}/comments`,
    { body_markdown: "wrong branch" },
    { ...pinned, ...key() }
  );
  assert.equal(comment.json().error.code, "BRANCH_MISMATCH");
  const legacyWrite = await call("PATCH", `/tasks/${mainTask.id}`, {
    title: "Old client edit",
    expected_version: 1
  });
  assert.equal(legacyWrite.statusCode, 200, "old clients send no branch");
});

test("claims belong to the session's branch", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const { call } = await s.createAgent("claude");
  const session = (
    await call("POST", "/sessions", {
      runtime: "claude",
      integration: "claude-code",
      branch_id: s.feature
    })
  ).json().session;
  const mainTask = (
    await s.alice(
      "POST",
      `/projects/${s.project.id}/tasks`,
      { title: "Main", status: "ready" },
      key()
    )
  ).json();
  const featureTask = (
    await s.alice(
      "POST",
      `/projects/${s.project.id}/tasks?branch_id=${s.feature}`,
      { title: "Feature", status: "ready" },
      key()
    )
  ).json();
  const wrong = await call("POST", `/tasks/${mainTask.id}/claim`, {
    session_id: session.id
  });
  assert.equal(wrong.statusCode, 409);
  assert.equal(wrong.json().error.code, "TASK_NOT_CLAIMABLE");
  assert.equal(wrong.json().error.details.reason, "branch_mismatch");
  const right = await call("POST", `/tasks/${featureTask.id}/claim`, {
    session_id: session.id
  });
  assert.equal(right.statusCode, 200, right.body);
  assert.equal(right.json().claim.branch_id, s.feature);
});

test("dependencies and blocks stay within a branch", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const mainTask = (
    await s.alice(
      "POST",
      `/projects/${s.project.id}/tasks`,
      { title: "Main" },
      key()
    )
  ).json();
  const featureTask = (
    await s.alice(
      "POST",
      `/projects/${s.project.id}/tasks?branch_id=${s.feature}`,
      { title: "Feature" },
      key()
    )
  ).json();
  const edge = await s.alice("POST", `/tasks/${mainTask.id}/dependencies`, {
    depends_on_task_id: featureTask.id,
    expected_version: 1
  });
  assert.equal(edge.statusCode, 400);
  assert.equal(edge.json().error.details.reason, "cross_branch");

  const { call } = await s.createAgent("codex");
  const session = (
    await call("POST", "/sessions", {
      runtime: "codex",
      integration: "codex",
      branch_id: s.feature
    })
  ).json().session;
  const ready = (
    await call(
      "POST",
      "/tasks",
      { title: "Claimable", status: "ready" },
      { "x-orchestrat-branch-id": s.feature, ...key() }
    )
  ).json();
  const claim = (
    await call("POST", `/tasks/${ready.id}/claim`, { session_id: session.id })
  ).json();
  const blocked = await call("POST", `/sessions/${session.id}/claims/status`, {
    claim_token: claim.claim_token,
    status: "blocked",
    reason: "Waiting on main",
    blocking_task_id: mainTask.id
  });
  assert.equal(blocked.statusCode, 400, blocked.body);
  assert.equal(blocked.json().error.details.reason, "cross_branch");

  const handoff = await call(
    "POST",
    "/handoffs",
    {
      to: { type: "human", id: s.aliceUser.id },
      body_markdown: "Please take the main task",
      task_id: mainTask.id
    },
    { "x-orchestrat-session-id": session.id, ...key() }
  );
  assert.equal(handoff.statusCode, 400, handoff.body);
  assert.equal(handoff.json().error.details.reason, "cross_branch");
});

test("idempotency keys are per branch, with a legacy replay on the default", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const shared = { "idempotency-key": "same-key" };
  const first = await s.alice(
    "POST",
    `/projects/${s.project.id}/tasks`,
    { title: "Same" },
    shared
  );
  const second = await s.alice(
    "POST",
    `/projects/${s.project.id}/tasks?branch_id=${s.feature}`,
    { title: "Same" },
    shared
  );
  assert.equal(second.statusCode, 201);
  assert.notEqual(first.json().id, second.json().id);
  const replay = await s.alice(
    "POST",
    `/projects/${s.project.id}/tasks`,
    { title: "Same" },
    shared
  );
  assert.equal(replay.json().id, first.json().id);

  // A key cached against the project before branches existed still replays.
  const legacyKey = { "idempotency-key": "legacy-key" };
  const cached = await s.alice(
    "POST",
    `/projects/${s.project.id}/tasks`,
    { title: "Legacy" },
    legacyKey
  );
  await s.db
    .update(apiIdempotencyKeys)
    .set({ resourceId: s.project.id })
    .where(eq(apiIdempotencyKeys.idempotencyKey, "legacy-key"));
  const legacy = await s.alice(
    "POST",
    `/projects/${s.project.id}/tasks`,
    { title: "Legacy" },
    legacyKey
  );
  assert.equal(legacy.statusCode, 201);
  assert.equal(legacy.json().id, cached.json().id);
  const tasks = (await s.alice("GET", `/projects/${s.project.id}/tasks`)).json()
    .tasks;
  assert.equal(tasks.length, 2, "the legacy replay created nothing");
});

test("lifecycle hooks pin sessions and session.ended closes branch siblings", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const { call } = await s.createAgent("claude");
  const hook = (
    event: string,
    sessionId: string,
    branchId?: string,
    idempotency = randomUUID()
  ) =>
    call(
      "POST",
      "/hooks/lifecycle",
      {
        event,
        session_id: sessionId,
        runtime: "claude",
        integration: "claude-code",
        external_session_id: "conversation-1"
      },
      {
        "idempotency-key": idempotency,
        ...(branchId ? { "x-orchestrat-branch-id": branchId } : {})
      }
    );
  const onFeature = randomUUID();
  const started = await hook("session.started", onFeature, s.feature);
  assert.equal(started.statusCode, 200, started.body);
  assert.equal(started.json().session.branch_id, s.feature);
  const moved = await hook("session.started", onFeature, s.main);
  assert.equal(moved.statusCode, 409);
  assert.equal(moved.json().error.details.reason, "branch_mismatch");

  const onMain = randomUUID();
  await hook("session.started", onMain);
  const ended = await hook("session.ended", onMain);
  assert.equal(ended.statusCode, 200, ended.body);
  const sessions = await s.db.select().from(agentSessions);
  assert.deepEqual(
    sessions.map((row) => row.status),
    ["closed", "closed"],
    "the sibling on the other branch closed too"
  );
});

test("presence lists every agent with its session branch", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const busy = await s.createAgent("busy");
  await s.createAgent("idle");
  await busy.call("POST", "/sessions", {
    runtime: "codex",
    integration: "codex",
    branch_id: s.feature
  });
  const presence = (
    await s.alice("GET", `/projects/${s.project.id}/presence`)
  ).json().agents;
  assert.equal(presence.length, 2);
  const byName = new Map(
    presence.map((entry: { agent_id: string; branch_id: string | null }) => [
      entry.agent_id,
      entry.branch_id
    ])
  );
  assert.equal(byName.get(busy.agent.id), s.feature);
  assert.equal(
    [...byName.values()].filter((value) => value === null).length,
    1
  );
  const agentView = (await busy.call("GET", "/presence")).json();
  assert.equal(agentView.agents.length, 2, "old doctor still sees every agent");
});

test("event feeds show a branch plus project-wide events", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  await s.alice(
    "POST",
    `/projects/${s.project.id}/tasks?branch_id=${s.feature}`,
    { title: "Feature" },
    key()
  );
  await s.alice(
    "POST",
    `/projects/${s.project.id}/tasks`,
    { title: "Main" },
    key()
  );
  const types = async (query: string) =>
    (await s.alice("GET", `/projects/${s.project.id}/events${query}`))
      .json()
      .events.filter((event: { type: string }) =>
        /^(task|branch)\./.test(event.type)
      )
      .map(
        (event: { type: string; branch_id: string | null }) =>
          `${event.type}@${event.branch_id === s.feature ? "feature" : event.branch_id === s.main ? "main" : "project"}`
      );
  assert.deepEqual(await types(""), [
    "branch.created@project",
    "task.created@main"
  ]);
  assert.deepEqual(await types(`?branch_id=${s.feature}`), [
    "branch.created@project",
    "task.created@feature"
  ]);
  assert.deepEqual(await types("?all_branches=true"), [
    "branch.created@project",
    "task.created@feature",
    "task.created@main"
  ]);
});

test("archived branches are read-only", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const task = (
    await s.alice(
      "POST",
      `/projects/${s.project.id}/tasks?branch_id=${s.feature}`,
      { title: "Frozen" },
      key()
    )
  ).json();
  await s.alice(
    "POST",
    `/projects/${s.project.id}/branches/${s.feature}/archive`,
    {}
  );
  const create = await s.alice(
    "POST",
    `/projects/${s.project.id}/tasks?branch_id=${s.feature}`,
    { title: "Late" },
    key()
  );
  assert.equal(create.statusCode, 409);
  assert.equal(create.json().error.code, "BRANCH_ARCHIVED");
  const edit = await s.alice("PATCH", `/tasks/${task.id}`, {
    title: "Edit",
    expected_version: 1
  });
  assert.equal(edit.statusCode, 409);
  assert.equal(edit.json().error.code, "CONFLICT");
  assert.equal(edit.json().error.details.reason, "branch_archived");
  const read = await s.alice("GET", `/tasks/${task.id}`);
  assert.equal(read.statusCode, 200, "archived work stays readable");
  const { call } = await s.createAgent("late");
  const session = await call("POST", "/sessions", {
    runtime: "codex",
    integration: "codex",
    branch_id: s.feature
  });
  assert.equal(session.statusCode, 409);
  assert.equal(session.json().error.code, "BRANCH_ARCHIVED");
});

test("agent attention follows the pinned branch", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const { call } = await s.createAgent("codex");
  const session = (
    await call("POST", "/sessions", {
      runtime: "codex",
      integration: "codex",
      branch_id: s.feature
    })
  ).json().session;
  const pinned = await call("GET", "/attention", undefined, {
    "x-orchestrat-session-id": session.id
  });
  assert.equal(pinned.statusCode, 200, pinned.body);
  assert.equal(pinned.json().branch_id, s.feature);
  assert.equal((await call("GET", "/attention")).json().branch_id, s.main);
});

test("task keys are unique per branch, not per project", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const original = (
    await s.alice(
      "POST",
      `/projects/${s.project.id}/tasks`,
      { title: "Original" },
      key()
    )
  ).json();
  // An import copies a task with its key onto another branch.
  const copy = {
    projectId: s.project.id,
    taskKey: original.key,
    taskNumber: Number(original.key.split("-").at(-1)),
    title: "Copy",
    createdByType: "human" as const,
    createdByUserId: s.aliceUser.id
  };
  await s.db
    .insert(tasks)
    .values({ ...copy, branchId: s.feature, originId: original.id });
  await assert.rejects(
    s.db.insert(tasks).values({ ...copy, branchId: s.main })
  );
});

test("branch permissions follow the role matrix", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const setRole = (role: "admin" | "member") =>
    s.db
      .update(projectMembers)
      .set({ role })
      .where(
        and(
          eq(projectMembers.projectId, s.project.id),
          eq(projectMembers.userId, s.bobUser.id)
        )
      );
  const attempt = async (
    as: typeof s.alice,
    action: "create" | "onboarding" | "default" | "archive"
  ) => {
    const branch = (
      await s.alice("POST", `/projects/${s.project.id}/branches`, {
        name: `feat/${randomUUID().slice(0, 8)}`
      })
    ).json().branch;
    const base = `/projects/${s.project.id}/branches`;
    const response =
      action === "create"
        ? await as("POST", base, { name: `feat/${randomUUID().slice(0, 8)}` })
        : await as(
            "POST",
            `${base}/${branch.id}/${action}`,
            action === "onboarding" ? { choice: "blank" } : {}
          );
    return response.statusCode;
  };
  const table = {
    owner: { create: 201, onboarding: 200, default: 200, archive: 200 },
    admin: { create: 201, onboarding: 200, default: 200, archive: 200 },
    member: { create: 201, onboarding: 200, default: 403, archive: 403 }
  } as const;
  for (const [role, expected] of Object.entries(table)) {
    if (role !== "owner") await setRole(role as "admin" | "member");
    const as = role === "owner" ? s.alice : s.bob;
    for (const [action, status] of Object.entries(expected))
      assert.equal(
        await attempt(as, action as keyof typeof expected),
        status,
        `${role} ${action}`
      );
    if (role !== "owner")
      await s.alice(
        "POST",
        `/projects/${s.project.id}/branches/${s.main}/default`,
        {}
      );
  }
  const { call } = await s.createAgent("codex");
  assert.equal(
    (
      await call("POST", `/projects/${s.project.id}/branches`, {
        name: "feat/agent"
      })
    ).statusCode,
    404,
    "agents register branches; they have no human branch routes"
  );
});
