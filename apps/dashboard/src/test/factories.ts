import {
  organizationSchema,
  projectSchema,
  workspaceSchema,
  type Organization,
  type Project,
  type Workspace
} from "@orchestrat/protocol";

const timestamp = "2024-01-01T00:00:00.000Z";

export function organization(overrides: Partial<Organization> = {}): Organization {
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

export function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return workspaceSchema.parse({
    id: "00000000-0000-4000-8000-000000000002",
    organization_id: organization().id,
    name: "Platform",
    slug: "platform",
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides
  });
}

export function project(overrides: Partial<Project> = {}): Project {
  return projectSchema.parse({
    id: "00000000-0000-4000-8000-000000000003",
    workspace_id: workspace().id,
    name: "Dashboard",
    slug: "dashboard",
    description: null,
    status: "active",
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null,
    ...overrides
  });
}
