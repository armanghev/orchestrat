import type { Organization, Project, Workspace } from "@orchestrat/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { loadProjectCatalog } from "./catalog";
import { hierarchyKeys, projectCatalogQueryOptions } from "./query-options";
import type { ApiClient } from "@/lib/api/client";

const timestamp = "2026-01-01T00:00:00.000Z";

const organization = (id: string, name: string): Organization => ({
  id,
  name,
  slug: id,
  role: "owner",
  created_at: timestamp,
  updated_at: timestamp
});

const workspace = (
  id: string,
  organizationId: string,
  name: string
): Workspace => ({
  id,
  organization_id: organizationId,
  name,
  slug: id,
  created_at: timestamp,
  updated_at: timestamp
});

const project = (id: string, workspaceId: string, name: string): Project => ({
  id,
  workspace_id: workspaceId,
  name,
  slug: id,
  description: null,
  status: "active",
  created_at: timestamp,
  updated_at: timestamp,
  archived_at: null
});

const organizations = [
  organization("00000000-0000-4000-8000-000000000001", "Zeta Organization"),
  organization("00000000-0000-4000-8000-000000000002", "Alpha Organization")
];
const workspaces = [
  workspace(
    "00000000-0000-4000-8000-000000000011",
    organizations[0].id,
    "Zeta Workspace"
  ),
  workspace(
    "00000000-0000-4000-8000-000000000012",
    organizations[0].id,
    "Alpha Workspace"
  ),
  workspace(
    "00000000-0000-4000-8000-000000000013",
    organizations[1].id,
    "Beta Workspace"
  )
];
const projects = [
  project(
    "00000000-0000-4000-8000-000000000021",
    workspaces[0].id,
    "Zulu Project"
  ),
  project(
    "00000000-0000-4000-8000-000000000022",
    workspaces[1].id,
    "Alpha Project"
  ),
  project(
    "00000000-0000-4000-8000-000000000023",
    workspaces[2].id,
    "Beta Project"
  )
];

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function apiStub(overrides: Partial<ApiClient>): ApiClient {
  return overrides as ApiClient;
}

describe("loadProjectCatalog", () => {
  it("starts each fan-out batch concurrently, links parents, and sorts by organization, workspace, then project", async () => {
    const workspaceResponses = new Map(
      organizations.map((item) => [
        item.id,
        deferred<{ workspaces: Workspace[] }>()
      ])
    );
    const projectResponses = new Map(
      workspaces.map((item) => [item.id, deferred<{ projects: Project[] }>()])
    );
    const workspaceStarts: string[] = [];
    const projectStarts: string[] = [];
    const api = apiStub({
      listOrganizations: vi.fn().mockResolvedValue({ organizations }),
      listWorkspaces: vi.fn((organizationId: string) => {
        workspaceStarts.push(organizationId);
        return workspaceResponses.get(organizationId)!.promise;
      }),
      listProjects: vi.fn((workspaceId: string) => {
        projectStarts.push(workspaceId);
        return projectResponses.get(workspaceId)!.promise;
      })
    });

    const result = loadProjectCatalog(queryClient(), api);

    await vi.waitFor(() => expect(workspaceStarts).toHaveLength(2));
    expect(projectStarts).toEqual([]);
    workspaceResponses
      .get(organizations[0].id)!
      .resolve({ workspaces: workspaces.slice(0, 2) });
    await Promise.resolve();
    expect(projectStarts).toEqual([]);
    workspaceResponses
      .get(organizations[1].id)!
      .resolve({ workspaces: [workspaces[2]] });

    await vi.waitFor(() => expect(projectStarts).toHaveLength(3));
    expect(projectStarts).toEqual(
      expect.arrayContaining(workspaces.map((item) => item.id))
    );
    for (const item of workspaces) {
      projectResponses
        .get(item.id)!
        .resolve({
          projects: projects.filter(
            (candidate) => candidate.workspace_id === item.id
          )
        });
    }

    await expect(result).resolves.toEqual({
      failures: [],
      projects: [
        {
          organization: organizations[1],
          workspace: workspaces[2],
          project: projects[2]
        },
        {
          organization: organizations[0],
          workspace: workspaces[1],
          project: projects[1]
        },
        {
          organization: organizations[0],
          workspace: workspaces[0],
          project: projects[0]
        }
      ]
    });
  });

  it("keeps other projects when a workspace project request fails", async () => {
    const failedWorkspace = workspaces[1];
    const api = apiStub({
      listOrganizations: vi.fn().mockResolvedValue({ organizations }),
      listWorkspaces: vi.fn((organizationId: string) =>
        Promise.resolve({
          workspaces: workspaces.filter(
            (item) => item.organization_id === organizationId
          )
        })
      ),
      listProjects: vi.fn((workspaceId: string) =>
        workspaceId === failedWorkspace.id
          ? Promise.reject(new Error("projects unavailable"))
          : Promise.resolve({
              projects: projects.filter(
                (item) => item.workspace_id === workspaceId
              )
            })
      )
    });

    await expect(loadProjectCatalog(queryClient(), api)).resolves.toMatchObject(
      {
        projects: [{ project: projects[2] }, { project: projects[0] }],
        failures: [
          {
            scope: "projects",
            parentId: failedWorkspace.id,
            message: "projects unavailable"
          }
        ]
      }
    );
  });

  it("records a failed organization workspace request while preserving other organizations", async () => {
    const failedOrganization = organizations[0];
    const api = apiStub({
      listOrganizations: vi.fn().mockResolvedValue({ organizations }),
      listWorkspaces: vi.fn((organizationId: string) =>
        organizationId === failedOrganization.id
          ? Promise.reject(new Error("workspaces unavailable"))
          : Promise.resolve({ workspaces: [workspaces[2]] })
      ),
      listProjects: vi.fn().mockResolvedValue({ projects: [projects[2]] })
    });

    await expect(loadProjectCatalog(queryClient(), api)).resolves.toEqual({
      projects: [
        {
          organization: organizations[1],
          workspace: workspaces[2],
          project: projects[2]
        }
      ],
      failures: [
        {
          scope: "workspaces",
          parentId: failedOrganization.id,
          message: "workspaces unavailable"
        }
      ]
    });
  });

  it("reloads stale hierarchy caches before returning a catalog", async () => {
    const client = queryClient();
    const staleOrganization = organization(
      organizations[0].id,
      "Stale Organization"
    );
    const staleWorkspace = workspace(
      workspaces[0].id,
      staleOrganization.id,
      "Stale Workspace"
    );
    const staleProject = project(
      projects[0].id,
      staleWorkspace.id,
      "Stale Project"
    );
    const freshOrganization = organization(
      staleOrganization.id,
      "Fresh Organization"
    );
    const freshWorkspace = workspace(
      staleWorkspace.id,
      freshOrganization.id,
      "Fresh Workspace"
    );
    const freshProject = project(
      staleProject.id,
      freshWorkspace.id,
      "Fresh Project"
    );

    client.setQueryData(
      hierarchyKeys.organizations(),
      { organizations: [staleOrganization] },
      { updatedAt: 0 }
    );
    client.setQueryData(
      hierarchyKeys.workspaces(staleOrganization.id),
      { workspaces: [staleWorkspace] },
      { updatedAt: 0 }
    );
    client.setQueryData(
      hierarchyKeys.projects(staleWorkspace.id),
      { projects: [staleProject] },
      { updatedAt: 0 }
    );
    const api = apiStub({
      listOrganizations: vi
        .fn()
        .mockResolvedValue({ organizations: [freshOrganization] }),
      listWorkspaces: vi
        .fn()
        .mockResolvedValue({ workspaces: [freshWorkspace] }),
      listProjects: vi.fn().mockResolvedValue({ projects: [freshProject] })
    });

    await expect(
      client.fetchQuery(projectCatalogQueryOptions(api))
    ).resolves.toEqual({
      failures: [],
      projects: [
        {
          organization: freshOrganization,
          workspace: freshWorkspace,
          project: freshProject
        }
      ]
    });
    expect(api.listOrganizations).toHaveBeenCalledTimes(1);
    expect(api.listWorkspaces).toHaveBeenCalledWith(freshOrganization.id);
    expect(api.listProjects).toHaveBeenCalledWith(freshWorkspace.id);
  });
});
