import type { ProjectCatalog } from "./catalog";

export type Landing =
  | { to: "/projects/$projectId/overview"; params: { projectId: string } }
  | { to: "/organizations/$organizationId"; params: { organizationId: string } }
  | {
      to: "/organizations/$organizationId/projects/new";
      params: { organizationId: string };
    }
  | { to: "/organizations/new" };

/**
 * Where a signed-in person lands: the most recent project they can still
 * open, else their first organization's projects, else organization creation.
 * `create` keeps the old /setup?create= links working.
 */
export function resolveLanding(
  catalog: ProjectCatalog,
  preferences: { recentProjectIds: string[]; pinnedProjectIds: string[] },
  create?: "organization" | "project"
): Landing {
  const firstOrganization = catalog.organizations[0];
  if (create === "organization" || !firstOrganization)
    return { to: "/organizations/new" };
  if (create === "project")
    return {
      to: "/organizations/$organizationId/projects/new",
      params: { organizationId: firstOrganization.id }
    };
  const accessible = new Set(catalog.projects.map(({ project }) => project.id));
  const projectId = [
    ...preferences.recentProjectIds,
    ...preferences.pinnedProjectIds
  ].find((id) => accessible.has(id));
  if (projectId)
    return { to: "/projects/$projectId/overview", params: { projectId } };
  return {
    to: "/organizations/$organizationId",
    params: { organizationId: firstOrganization.id }
  };
}
