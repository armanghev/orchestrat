import type { ProjectCatalog } from "@/features/hierarchy/catalog";
import type { Theme } from "@/features/theme/theme";

export type AppCommand = {
  id: string;
  group: "Projects" | "Navigate" | "Appearance" | "Application";
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
  "activity",
  "settings"
] as const;
export type NavigationDestination = (typeof navigationDestinations)[number];

export type BuildCommandsOptions = {
  catalog: ProjectCatalog;
  activeProjectId?: string;
  navigateToProject: (projectId: string) => void | Promise<void>;
  navigateToRoute: (
    route: NavigationDestination,
    projectId?: string
  ) => void | Promise<void>;
  setTheme: (theme: Theme) => void | Promise<void>;
  toggleSidebar: () => void | Promise<void>;
  openPreferences: () => void | Promise<void>;
  signOut: () => void | Promise<void>;
};

const title = (route: string) => route[0].toUpperCase() + route.slice(1);

export function buildCommands({
  catalog,
  activeProjectId,
  navigateToProject,
  navigateToRoute,
  setTheme,
  toggleSidebar,
  openPreferences,
  signOut
}: BuildCommandsOptions): AppCommand[] {
  return [
    ...catalog.projects.map(({ project, organization }) => ({
      id: `project:${project.id}`,
      group: "Projects" as const,
      label: `Open ${project.name}`,
      keywords: [
        "project",
        "organization",
        project.name,
        organization.name
      ],
      run: () => navigateToProject(project.id)
    })),
    ...navigationDestinations.map((route) => ({
      id: `navigate:${route}`,
      group: "Navigate" as const,
      label: title(route),
      keywords: ["navigate", route],
      run: () => navigateToRoute(route, activeProjectId)
    })),
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
