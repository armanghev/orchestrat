import type { Organization, Project, Workspace } from "@orchestrat/protocol";
import type { QueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/lib/api/client";
import {
  organizationsQueryOptions,
  projectsQueryOptions,
  workspacesQueryOptions
} from "./query-options";

export type ProjectContext = {
  organization: Organization;
  workspace: Workspace;
  project: Project;
};

export type CatalogFailure = {
  scope: "workspaces" | "projects";
  parentId: string;
  message: string;
};

export type ProjectCatalog = {
  projects: ProjectContext[];
  failures: CatalogFailure[];
};

type WorkspaceResult =
  | { organization: Organization; workspaces: Workspace[] }
  | { failure: CatalogFailure };

type ProjectResult =
  | { projects: ProjectContext[] }
  | { failure: CatalogFailure };

function failure(
  scope: CatalogFailure["scope"],
  parentId: string,
  error: unknown
): CatalogFailure {
  return {
    scope,
    parentId,
    message: error instanceof Error ? error.message : "Unable to load hierarchy data."
  };
}

export async function loadProjectCatalog(
  queryClient: QueryClient,
  api: ApiClient
): Promise<ProjectCatalog> {
  const { organizations } = await queryClient.fetchQuery(
    organizationsQueryOptions(api)
  );

  const workspaceResults: WorkspaceResult[] = await Promise.all(
    organizations.map(async (organization) => {
      try {
        const { workspaces } = await queryClient.fetchQuery(
          workspacesQueryOptions(api, organization.id)
        );
        return { organization, workspaces };
      } catch (error) {
        return { failure: failure("workspaces", organization.id, error) };
      }
    })
  );

  const failures: CatalogFailure[] = workspaceResults.flatMap((result) =>
    "failure" in result ? [result.failure] : []
  );
  const successfulWorkspaces = workspaceResults.flatMap((result) =>
    "workspaces" in result
      ? result.workspaces.map((workspace) => ({ organization: result.organization, workspace }))
      : []
  );

  const projectResults: ProjectResult[] = await Promise.all(
    successfulWorkspaces.map(async ({ organization, workspace }) => {
      try {
        const { projects } = await queryClient.fetchQuery(
          projectsQueryOptions(api, workspace.id)
        );
        return {
          projects: projects.map((project) => ({ organization, workspace, project }))
        };
      } catch (error) {
        return { failure: failure("projects", workspace.id, error) };
      }
    })
  );

  failures.push(
    ...projectResults.flatMap((result) => ("failure" in result ? [result.failure] : []))
  );
  const projects = projectResults
    .flatMap((result) => ("projects" in result ? result.projects : []))
    .sort(
      (left, right) =>
        left.organization.name.localeCompare(right.organization.name) ||
        left.workspace.name.localeCompare(right.workspace.name) ||
        left.project.name.localeCompare(right.project.name)
    );

  return { projects, failures };
}
