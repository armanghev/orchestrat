import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { organization, project } from "@/test/factories";
import type { ApiClient } from "@/lib/api/client";
import { loadProjectCatalog } from "./catalog";
import { hierarchyKeys, projectCatalogQueryOptions } from "./query-options";

function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function apiStub(overrides: Partial<ApiClient>) {
  return overrides as ApiClient;
}

describe("loadProjectCatalog", () => {
  it("loads organization projects concurrently and sorts their contexts", async () => {
    const zeta = organization({
      id: "00000000-0000-4000-8000-000000000011",
      name: "Zeta"
    });
    const alpha = organization({
      id: "00000000-0000-4000-8000-000000000012",
      name: "Alpha"
    });
    const api = apiStub({
      listOrganizations: vi
        .fn()
        .mockResolvedValue({ organizations: [zeta, alpha] }),
      listProjects: vi.fn((organizationId: string) =>
        Promise.resolve({
          projects: [
            project({
              organization_id: organizationId,
              name: organizationId === alpha.id ? "Beta" : "Alpha"
            })
          ]
        })
      )
    });

    await expect(loadProjectCatalog(queryClient(), api)).resolves.toMatchObject(
      {
        failures: [],
        projects: [
          { organization: alpha, project: { name: "Beta" } },
          { organization: zeta, project: { name: "Alpha" } }
        ]
      }
    );
    expect(api.listProjects).toHaveBeenCalledWith(zeta.id);
    expect(api.listProjects).toHaveBeenCalledWith(alpha.id);
  });

  it("keeps available projects when one organization request fails", async () => {
    const available = organization({
      id: "00000000-0000-4000-8000-000000000011"
    });
    const unavailable = organization({
      id: "00000000-0000-4000-8000-000000000012"
    });
    const api = apiStub({
      listOrganizations: vi
        .fn()
        .mockResolvedValue({ organizations: [available, unavailable] }),
      listProjects: vi.fn((organizationId: string) =>
        organizationId === unavailable.id
          ? Promise.reject(new Error("projects unavailable"))
          : Promise.resolve({
              projects: [project({ organization_id: available.id })]
            })
      )
    });

    await expect(loadProjectCatalog(queryClient(), api)).resolves.toMatchObject(
      {
        projects: [{ organization: available }],
        failures: [
          {
            scope: "projects",
            parentId: unavailable.id,
            message: "projects unavailable"
          }
        ]
      }
    );
  });

  it("refreshes stale organization and project queries", async () => {
    const client = queryClient();
    const fresh = organization({ name: "Fresh" });
    const api = apiStub({
      listOrganizations: vi.fn().mockResolvedValue({ organizations: [fresh] }),
      listProjects: vi.fn().mockResolvedValue({
        projects: [
          project({ organization_id: fresh.id, name: "Fresh project" })
        ]
      })
    });
    client.setQueryData(
      hierarchyKeys.organizations(),
      { organizations: [organization({ name: "Stale" })] },
      { updatedAt: 0 }
    );

    await expect(
      client.fetchQuery(projectCatalogQueryOptions(api))
    ).resolves.toMatchObject({
      projects: [{ organization: fresh, project: { name: "Fresh project" } }]
    });
  });
});
