import {
  agentAttentionSchema,
  taskBlockSchema,
  attentionSummarySchema,
  taskAttentionOverlaySchema,
  taskCommentSchema,
  organizationSchema,
  projectSchema,
  taskCardSchema,
  documentDetailSchema,
  type AgentAttention,
  type TaskBlock,
  type AttentionSummary,
  type TaskAttentionOverlay,
  type TaskComment,
  type Organization,
  type Project,
  type TaskCard,
  type DocumentDetail
} from "@orchestrat/protocol";

const timestamp = "2024-01-01T00:00:00.000Z";

export function organization(
  overrides: Partial<Organization> = {}
): Organization {
  return organizationSchema.parse({
    id: "00000000-0000-4000-8000-000000000001",
    name: "Acme Corporation",
    slug: "acme-corporation",
    role: "owner",
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides
  });
}

export function project(overrides: Partial<Project> = {}): Project {
  return projectSchema.parse({
    id: "00000000-0000-4000-8000-000000000003",
    organization_id: organization().id,
    name: "Dashboard",
    slug: "dashboard",
    description: null,
    status: "active",
    role: "owner",
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null,
    ...overrides
  });
}

export function taskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return taskCardSchema.parse({
    id: "00000000-0000-4000-8000-000000000006",
    project_id: project().id,
    key: "DASH-1",
    title: "First task",
    description: null,
    priority: "medium",
    status: "ready",
    position: 0,
    version: 1,
    created_by: {
      type: "human",
      id: "00000000-0000-4000-8000-000000000004"
    },
    created_by_user_id: "00000000-0000-4000-8000-000000000004",
    created_at: timestamp,
    updated_at: timestamp,
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    comment_count: 0,
    unresolved_blocker_count: 0,
    ...overrides
  });
}

export function documentDetail(
  overrides: Partial<DocumentDetail> = {}
): DocumentDetail {
  const document = {
    id: "00000000-0000-4000-8000-000000000007",
    project_id: project().id,
    path: "README.md",
    current_revision: 1,
    archived_at: null,
    created_by: {
      type: "human" as const,
      id: "00000000-0000-4000-8000-000000000004"
    },
    created_at: timestamp,
    updated_at: timestamp
  };
  return documentDetailSchema.parse({
    document,
    revision: {
      id: "00000000-0000-4000-8000-000000000008",
      document_id: document.id,
      revision_number: 1,
      content: "Initial content",
      author: document.created_by,
      created_at: timestamp
    },
    ...overrides
  });
}

export function taskComment(
  overrides: Partial<TaskComment> & { sequence: number }
): TaskComment {
  const userId = "00000000-0000-4000-8000-000000000004";
  return taskCommentSchema.parse({
    id: `00000000-0000-4000-8000-${String(100 + overrides.sequence).padStart(12, "0")}`,
    task_id: taskCard().id,
    author: {
      type: "human",
      id: userId,
      user_id: userId,
      agent_id: null,
      username: "tester",
      full_name: "Test User",
      avatar_url: null
    },
    body_markdown: `Comment ${overrides.sequence}`,
    mentions: [],
    created_at: timestamp,
    ...overrides
  });
}

export function attentionSummary(
  overrides: Partial<AttentionSummary> = {}
): AttentionSummary {
  return attentionSummarySchema.parse({
    cursor: "0",
    branch_id: null,
    unread_chats: [],
    tasks: [],
    handoffs: [],
    blockers_resolved: [],
    truncated: false,
    ...overrides
  });
}

export function attentionTaskItem(
  overrides: Partial<AttentionSummary["tasks"][number]> = {}
): AttentionSummary["tasks"][number] {
  const task = taskCard();
  return attentionSummarySchema.shape.tasks.element.parse({
    task_id: task.id,
    key: task.key,
    title: task.title,
    status: task.status,
    watching: true,
    claimed_by_you: false,
    unread_count: 0,
    mention_count: 0,
    blocking_unread_count: 0,
    last_read_sequence: 0,
    latest_sequence: 0,
    unread: [],
    ...overrides
  });
}

export function taskAttentionOverlay(
  overrides: Partial<TaskAttentionOverlay> = {}
): TaskAttentionOverlay {
  return taskAttentionOverlaySchema.parse({
    task_id: taskCard().id,
    watching: true,
    unread_count: 0,
    mention_count: 0,
    claim: null,
    block: null,
    ...overrides
  });
}

export function taskBlock(overrides: Partial<TaskBlock> = {}): TaskBlock {
  return taskBlockSchema.parse({
    id: "00000000-0000-4000-8000-000000000040",
    task_id: taskCard().id,
    reason: "Waiting for the API contract.",
    blocking_task: null,
    blocked_on: null,
    created_by: {
      type: "agent",
      id: "00000000-0000-4000-8000-000000000020",
      name: "claude-code"
    },
    created_at: timestamp,
    resolved_at: null,
    resolution: null,
    ...overrides
  });
}

export function agentAttention(
  overrides: Partial<AgentAttention> = {}
): AgentAttention {
  return agentAttentionSchema.parse({
    agent_id: "00000000-0000-4000-8000-000000000020",
    waiting_since: null,
    pending_directed_count: 0,
    open_block: null,
    current_task: null,
    ...overrides
  });
}
