import type { Branch } from "@orchestrat/protocol";
import type { ProjectCatalog } from "@/features/hierarchy/catalog";
import type { Theme } from "@/features/theme/theme";

export type AppCommand = {
  id: string;
  group:
    | "Organizations"
    | "Projects"
    | "Branches"
    | "Navigate"
    | "Appearance"
    | "Application";
  label: string;
  keywords: string[];
  destructive?: boolean;
  run(): void | Promise<void>;
};

export const navigationDestinations = [
  "overview",
  "tasks",
  "agents",
  "documents",
  "messages",
  "activity",
  "decisions",
  "settings"
] as const;
export type NavigationDestination = (typeof navigationDestinations)[number];

export const organizationDestinations = [
  "projects",
  "members",
  "settings"
] as const;
export type OrganizationDestination = (typeof organizationDestinations)[number];

export type BuildCommandsOptions = {
  catalog: ProjectCatalog;
  activeProjectId?: string;
  /** Set on organization pages, where there is no active project. */
  activeOrganizationId?: string;
  navigateToOrganization?: (
    organizationId: string,
    destination: OrganizationDestination
  ) => void | Promise<void>;
  navigateToProject: (projectId: string) => void | Promise<void>;
  navigateToRoute: (
    route: NavigationDestination,
    projectId?: string
  ) => void | Promise<void>;
  setTheme: (theme: Theme) => void | Promise<void>;
  toggleSidebar: () => void | Promise<void>;
  openPreferences: () => void | Promise<void>;
  signOut: () => void | Promise<void>;
  /** The active project's branches; the breadcrumb menu is hidden on phones,
   * so ⌘K switches branches there (docs/project-branches.md §11.2). */
  branches?: {
    branches: Branch[];
    currentBranchId: string;
    canCreate: boolean;
    selectBranch: (branchId: string) => void;
    openCreateBranch: () => void;
  };
};

const title = (route: string) => route[0].toUpperCase() + route.slice(1);

export function buildCommands({
  catalog,
  activeProjectId,
  activeOrganizationId,
  navigateToOrganization,
  navigateToProject,
  navigateToRoute,
  setTheme,
  toggleSidebar,
  openPreferences,
  signOut,
  branches
}: BuildCommandsOptions): AppCommand[] {
  return [
    ...(navigateToOrganization
      ? catalog.organizations.map((organization) => ({
          id: `organization:${organization.id}`,
          group: "Organizations" as const,
          label: `Open ${organization.name}`,
          keywords: ["organization", "projects", organization.name],
          run: () => navigateToOrganization(organization.id, "projects")
        }))
      : []),
    ...catalog.projects.map(({ project, organization }) => ({
      id: `project:${project.id}`,
      group: "Projects" as const,
      label: `Open ${project.name}`,
      keywords: ["project", "organization", project.name, organization.name],
      run: () => navigateToProject(project.id)
    })),
    ...(branches?.branches ?? [])
      .filter(
        (branch) =>
          !branch.archived_at && branch.id !== branches?.currentBranchId
      )
      .map((branch) => ({
        id: `branch:${branch.id}`,
        group: "Branches" as const,
        label: `Switch to branch ${branch.name}`,
        keywords: ["branch", "switch", branch.name],
        run: () => branches?.selectBranch(branch.id)
      })),
    ...(branches?.canCreate
      ? [
          {
            id: "branch:new",
            group: "Branches" as const,
            label: "New branch",
            keywords: ["branch", "create", "new"],
            run: branches.openCreateBranch
          }
        ]
      : []),
    ...(activeProjectId || !activeOrganizationId
      ? navigationDestinations.map((route) => ({
          id: `navigate:${route}`,
          group: "Navigate" as const,
          label: title(route),
          keywords: ["navigate", route],
          run: () => navigateToRoute(route, activeProjectId)
        }))
      : organizationDestinations.map((destination) => ({
          id: `navigate:organization-${destination}`,
          group: "Navigate" as const,
          label: title(destination),
          keywords: ["navigate", "organization", destination],
          run: () => navigateToOrganization?.(activeOrganizationId, destination)
        }))),
    ...(["system", "light", "dark"] as const).map((theme) => ({
      id: `theme:${theme}`,
      group: "Appearance" as const,
      label: `${title(theme)} theme`,
      keywords: ["theme", "appearance", theme],
      run: () => setTheme(theme)
    })),
    {
      id: "sidebar:toggle",
      group: "Appearance" as const,
      label: "Toggle sidebar",
      keywords: ["sidebar", "collapse"],
      run: toggleSidebar
    },
    {
      id: "preferences:open",
      group: "Application" as const,
      label: "Open preferences",
      keywords: ["preferences", "settings"],
      run: openPreferences
    },
    {
      id: "auth:sign-out",
      group: "Application" as const,
      label: "Sign out",
      keywords: ["auth", "account", "logout"],
      destructive: true,
      run: signOut
    }
  ];
}
