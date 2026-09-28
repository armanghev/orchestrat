import {
  organizationSchema,
  projectSchema,
  taskCardSchema,
  documentDetailSchema,
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
