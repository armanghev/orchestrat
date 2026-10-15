import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  projectEvents,
  projectMembers,
  repositoryConnections,
  tasks
} from "@orchestrat/db";
import { projectSummariesResponseSchema } from "@orchestrat/protocol";
import { eq } from "drizzle-orm";
import type { workspaceOn } from "./workspace.js";

export async function checkProjectSummaries(
  s: Awaited<ReturnType<typeof workspaceOn>>
) {
  const base = `/organizations/${s.organization.id}`;
  const empty = (
    await s.alice("POST", `${base}/projects`, { name: "Empty" })
  ).json();
  const hidden = (
    await s.alice("POST", `${base}/projects`, { name: "Hidden" })
  ).json();
  await s.db
    .insert(projectMembers)
    .values({ projectId: empty.id, userId: s.bobUser.id, role: "admin" });
  // Even an organization owner must have project membership.
  await s.db
    .delete(projectMembers)
    .where(eq(projectMembers.projectId, hidden.id));
  const feature = (
    await s.alice("POST", `/projects/${s.project.id}/branches`, {
      name: "feat/summary"
    })
  ).json().branch;
  const statuses = [
    "backlog",
    "ready",
    "claimed",
    "in_progress",
    "blocked",
    "review",
    "done",
    "cancelled"
  ] as const;
  await s.db.insert(tasks).values(
    statuses.map((status, i) => ({
      projectId: s.project.id,
      branchId: s.project.default_branch_id,
      taskKey: `ORC-${i + 1}`,
      taskNumber: i + 1,
      title: status,
      status,
      createdByType: "human" as const,
      createdByUserId: s.aliceUser.id
    }))
  );
  await s.db.insert(tasks).values({
    projectId: s.project.id,
    branchId: feature.id,
    taskKey: "ORC-20",
    taskNumber: 20,
    title: "Excluded feature task",
    status: "ready",
    createdByType: "human",
    createdByUserId: s.aliceUser.id
  });
  await s.db
    .delete(projectEvents)
    .where(eq(projectEvents.projectId, s.project.id));
  await s.db.insert(projectEvents).values([
    {
      projectId: s.project.id,
      branchId: feature.id,
      type: "task.created",
      payload: {},
      occurredAt: new Date("2026-10-06T12:00:00.000Z")
    },
    {
      projectId: s.project.id,
      type: "repository.connected",
      payload: {},
      occurredAt: new Date("2026-10-05T12:00:00.000Z")
    }
  ]);
  await s.db.insert(repositoryConnections).values([
    {
      projectId: s.project.id,
      provider: "gitlab",
      providerRepositoryId: randomUUID(),
      repositoryFullName: "acme/old",
      providerDefaultBranch: "main",
      status: "disconnected",
      disconnectedAt: new Date()
    },
    {
      projectId: s.project.id,
      provider: "github",
      providerRepositoryId: randomUUID(),
      repositoryFullName: "acme/current",
      providerDefaultBranch: "main",
      status: "needs_reauthorization"
    }
  ]);
  assert.equal(
    (await s.alice("POST", `/projects/${s.project.id}/archive`)).statusCode,
    200
  );
  // An unrelated organization must not contribute rows or aggregate counts.
  const other = (
    await s.alice("POST", "/organizations", { name: `Other ${randomUUID()}` })
  ).json();
  await s.alice("POST", `/organizations/${other.id}/projects`, {
    name: "Other project"
  });
  const response = await s.alice("GET", `${base}/project-summaries`);
  assert.equal(response.statusCode, 200, response.body);
  const summaries = projectSummariesResponseSchema.parse(
    response.json()
  ).projects;
  assert.deepEqual(
    summaries.map((p) => p.id),
    [empty.id, s.project.id]
  );
  assert.equal(summaries[0]!.member_count, 2);
  assert.equal(summaries[0]!.open_task_count, 0);
  assert.equal(summaries[0]!.last_activity_at, null);
  assert.equal(summaries[0]!.repository, null);
  assert.equal(summaries[1]!.status, "archived");
  assert.ok(summaries[1]!.archived_at);
  assert.equal(summaries[1]!.role, "owner");
  assert.equal(summaries[1]!.task_key_prefix, "ORC");
  assert.equal(summaries[1]!.default_branch_id, s.project.default_branch_id);
  assert.equal(summaries[1]!.default_branch_name, "main");
  assert.equal(summaries[1]!.member_count, 2);
  assert.equal(summaries[1]!.open_task_count, 6);
  assert.equal(summaries[1]!.last_activity_at, "2026-10-06T12:00:00.000Z");
  assert.deepEqual(summaries[1]!.repository, {
    provider: "github",
    full_name: "acme/current",
    status: "needs_reauthorization"
  });
  const bob = (await s.bob("GET", `${base}/project-summaries`)).json().projects;
  assert.deepEqual(
    bob.map((p: { role: string }) => p.role),
    ["admin", "member"]
  );
  assert.equal(
    (await s.bob("GET", `/organizations/${other.id}/project-summaries`))
      .statusCode,
    403
  );
  assert.equal(
    (await s.alice("GET", `/organizations/${randomUUID()}/project-summaries`))
      .statusCode,
    403
  );
  assert.equal(
    (await s.alice("GET", "/organizations/invalid/project-summaries"))
      .statusCode,
    400
  );
  assert.equal(
    (
      await s.app.inject({
        method: "GET",
        url: `/api/v1${base}/project-summaries`
      })
    ).statusCode,
    401
  );
  const vacant = (
    await s.alice("POST", "/organizations", { name: `Vacant ${randomUUID()}` })
  ).json();
  assert.deepEqual(
    (
      await s.alice("GET", `/organizations/${vacant.id}/project-summaries`)
    ).json(),
    { projects: [] }
  );
}
