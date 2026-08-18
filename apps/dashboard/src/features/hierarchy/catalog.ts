import type { Organization, Project } from "@orchestrat/protocol";
import type { QueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/lib/api/client";
import { organizationsQueryOptions, projectsQueryOptions } from "./query-options";

export type ProjectContext = { organization: Organization; project: Project };
export type CatalogFailure = { scope: "projects"; parentId: string; message: string };
export type ProjectCatalog = { projects: ProjectContext[]; failures: CatalogFailure[] };

export async function loadProjectCatalog(
  queryClient: QueryClient,
  api: ApiClient
): Promise<ProjectCatalog> {
  const { organizations } = await queryClient.fetchQuery(
    organizationsQueryOptions(api)
  );
  const results = await Promise.all(
    organizations.map(async (organization) => {
      try {
        const { projects } = await queryClient.fetchQuery(
          projectsQueryOptions(api, organization.id)
        );
        return { projects: projects.map((project) => ({ organization, project })) };
      } catch (error) {
        return {
          failure: {
            scope: "projects" as const,
            parentId: organization.id,
            message: error instanceof Error ? error.message : "Unable to load projects."
          }
        };
      }
    })
  );
  return {
    projects: results
      .flatMap((result) => ("projects" in result ? result.projects : []))
      .sort(
        (left, right) =>
          left.organization.name.localeCompare(right.organization.name) ||
          left.project.name.localeCompare(right.project.name)
      ),
    failures: results.flatMap((result) => ("failure" in result ? [result.failure] : []))
  };
}
