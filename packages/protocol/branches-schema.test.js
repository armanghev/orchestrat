import assert from "node:assert/strict";
import test from "node:test";
import {
  BRANCH_ID_HEADER,
  SESSION_ID_HEADER,
  agentSessionSchema,
  allBranchesQuerySchema,
  apiErrorResponseSchema,
  branchNameSchema,
  branchSchema,
  connectRepositoryRequestSchema,
  createRepositoryAuthorizationRequestSchema,
  githubInstallationRequestSchema,
  githubInstallationResponseSchema,
  inboxSummarySchema,
  mergeApplyRequestSchema,
  mergeSelectionSchema,
  openAgentSessionRequestSchema,
  projectEventSchema,
  projectSchema,
  realtimeEventEnvelopeSchema,
  registerBranchRequestSchema,
  taskSchema
} from "./dist/index.js";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const timestamp = "2026-09-30T00:00:00.000Z";

test("branch names follow the git ref subset from spec §4.6", () => {
  for (const name of [
    "main",
    "feat/login",
    "release/1.2",
    "fix/ISSUE-12_x",
    "user@feature",
    "a.b"
  ]) {
    assert.equal(branchNameSchema.parse(name), name, name);
  }
  for (const name of [
    "",
    "-x",
    "/x",
    "x/",
    "a..b",
    "a b",
    "x.lock",
    "@",
    "a//b",
    "a@{b",
    "a~b",
    "a:b",
    "a^b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
    "a\u0007b",
    "x".repeat(256)
  ]) {
    assert.equal(branchNameSchema.safeParse(name).success, false, name);
  }
});

test("old payloads without branch fields still parse", () => {
  const task = taskSchema.parse({
    id,
    project_id: id,
    key: "ORC-12",
    title: "Legacy task",
    description: null,
    priority: "none",
    status: "ready",
    position: 0,
    version: 1,
    created_by: { type: "human", id },
    created_by_user_id: id,
    created_at: timestamp,
    updated_at: timestamp,
    started_at: null,
    completed_at: null,
    cancelled_at: null
  });
  assert.equal(task.branch_id, undefined);
  const project = projectSchema.parse({
    id,
    organization_id: id,
    name: "orchestrat",
    slug: "orchestrat",
    description: null,
    status: "active",
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null
  });
  assert.equal(project.default_branch_id, undefined);
  assert.deepEqual(
    openAgentSessionRequestSchema.parse({
      runtime: "codex",
      integration: "codex"
    }),
    { runtime: "codex", integration: "codex" }
  );
  assert.equal(
    inboxSummarySchema.parse({
      unread_chats: [{ chat_id: id, unread_count: 1, mention_count: 0 }]
    }).unread_chats[0].branch_id,
    undefined
  );
});

test("new payloads carry branch ids additively", () => {
  const session = agentSessionSchema.parse({
    id,
    agent_id: id,
    project_id: id,
    branch_id: other,
    runtime: "claude",
    integration: "claude-code",
    external_session_id: null,
    status: "active",
    started_at: timestamp,
    ended_at: null,
    last_heartbeat_at: timestamp
  });
  assert.equal(session.branch_id, other);
  const event = projectEventSchema.parse({
    id: 7,
    project_id: id,
    branch_id: null,
    type: "branch.created",
    actor_agent_id: null,
    actor_user_id: id,
    entity_id: other,
    payload: {},
    occurred_at: timestamp
  });
  assert.equal(event.branch_id, null);
});

test("realtime accepts branch, merge, decision and repository namespaces", () => {
  for (const [entity_type, event_type, branch_id] of [
    ["branch", "branch.created", null],
    ["merge", "merge.import_applied", other],
    ["decision", "decision.opened", other],
    ["repository", "repository.connected", null]
  ]) {
    const envelope = realtimeEventEnvelopeSchema.parse({
      project_id: id,
      branch_id,
      sequence: 1,
      event_type,
      entity_type,
      entity_id: id
    });
    assert.equal(envelope.branch_id, branch_id);
  }
  assert.equal(
    realtimeEventEnvelopeSchema.safeParse({
      project_id: id,
      sequence: 1,
      event_type: "task.created",
      entity_type: "branch",
      entity_id: id
    }).success,
    false
  );
});

test("branch error codes are part of the closed error enum", () => {
  for (const code of [
    "BRANCH_NOT_FOUND",
    "BRANCH_ARCHIVED",
    "BRANCH_MISMATCH",
    "BRANCH_NAME_TAKEN",
    "BRANCH_PREVIEW_STALE",
    "BRANCH_DECISION_STALE",
    "REPOSITORY_NOT_CONFIGURED",
    "REPOSITORY_AUTHORIZATION_INVALID",
    "REPOSITORY_CONNECTION_EXISTS"
  ]) {
    assert.equal(
      apiErrorResponseSchema.parse({
        error: { code, message: "x", details: {}, request_id: "req_1" }
      }).error.code,
      code
    );
  }
});

test("branch objects and branch requests validate", () => {
  const branch = branchSchema.parse({
    id,
    project_id: id,
    name: "feat/login",
    is_default: false,
    name_source: "user",
    created_via: "cli",
    created_by: { type: "agent", id: other },
    onboarding_state: "pending",
    onboarding_choice: null,
    archived_at: null,
    archived_reason: null,
    provider: { provider: "github", state: "tracked", head_sha: "abc1234" },
    open_decision_count: 0,
    created_at: timestamp,
    updated_at: timestamp
  });
  assert.equal(branch.name, "feat/login");
  assert.equal(
    registerBranchRequestSchema.safeParse({ name: "feat/x", head_sha: "XYZ" })
      .success,
    false
  );
  assert.deepEqual(allBranchesQuerySchema.parse({}), { all_branches: false });
  assert.deepEqual(allBranchesQuerySchema.parse({ all_branches: "true" }), {
    all_branches: true
  });
  assert.equal(BRANCH_ID_HEADER, "x-orchestrat-branch-id");
  assert.equal(SESSION_ID_HEADER, "x-orchestrat-session-id");
});

test("merge requests default to an empty, explicit selection", () => {
  assert.deepEqual(mergeSelectionSchema.parse({}), {
    tasks: [],
    documents: [],
    chats: []
  });
  const apply = mergeApplyRequestSchema.parse({
    source_branch_id: id,
    target_branch_id: other,
    kind: "import",
    selection: { tasks: "all" },
    preview_fingerprint: "a".repeat(64)
  });
  assert.deepEqual(apply.choices, {});
  assert.equal(apply.archive_source, false);
  assert.equal(apply.complete_onboarding, false);
  assert.equal(
    mergeApplyRequestSchema.safeParse({
      source_branch_id: id,
      target_branch_id: other,
      kind: "import",
      choices: { [id]: "keep_both" },
      preview_fingerprint: "a".repeat(64)
    }).success,
    false
  );
});

test("repository requests reject untrusted inputs", () => {
  assert.equal(
    githubInstallationRequestSchema.safeParse({ installation_id: "12ab" })
      .success,
    false
  );
  assert.deepEqual(
    githubInstallationResponseSchema.parse({ next: "pick_repository" }),
    { next: "pick_repository" }
  );
  for (const return_path of ["//evil.example", "https://evil.example", "x"]) {
    assert.equal(
      createRepositoryAuthorizationRequestSchema.safeParse({
        provider: "github",
        return_path
      }).success,
      false,
      return_path
    );
  }
  const connect = connectRepositoryRequestSchema.parse({
    authorization_id: "ra_abcdefghijklmnopqrstuv",
    provider_repository_id: "123"
  });
  assert.deepEqual(connect.default_branch_mapping, { mode: "rename_default" });
  assert.equal(connect.create_existing_branches, false);
});
