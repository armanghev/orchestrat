import {
  organizationSchema,
  projectSchema,
  type Organization,
  type Project
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
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null,
    ...overrides
  });
}
