import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import type { ProjectCatalog } from "@/features/hierarchy/catalog";
import {
  buildCommands,
  type NavigationDestination
} from "@/features/command/commands";
import { orderProjects } from "@/features/hierarchy/project-order";
import { useTheme } from "@/features/theme/theme-provider";
import { usePreferences } from "@/platform/preferences-provider";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { ContextSidebar } from "./context-sidebar";
import { TopToolbar } from "./top-toolbar";
import { CommandMenu } from "./command-menu";
import { ConnectivityBanner } from "@/features/connectivity/connectivity-banner";

export type AppShellProps = {
  catalog: ProjectCatalog;
  activeProjectId?: string;
  activeRoute?: NavigationDestination;
  navigateToProject: (projectId: string) => void | Promise<void>;
  navigateToRoute: (
    route: NavigationDestination,
    projectId?: string
  ) => void | Promise<void>;
  openPreferences: () => void | Promise<void>;
  signOut: () => void | Promise<void>;
  retryCatalog?: () => void | Promise<void>;
  children: ReactNode;
};

export function AppShell({
  catalog,
  activeProjectId,
  activeRoute = "overview",
  navigateToProject,
  navigateToRoute,
  openPreferences,
  signOut,
  retryCatalog,
  children
}: AppShellProps) {
  const { preferences, update } = usePreferences();
  const { setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const commandInvokerRef = useRef<HTMLElement>(null);
  const defaultCommandTriggerRef = useRef<HTMLButtonElement>(null);
  const openCommands = useCallback(() => {
    const activeElement = document.activeElement;
    commandInvokerRef.current =
      activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : defaultCommandTriggerRef.current;
    setOpen(true);
  }, []);
  const current = catalog.projects.find(
    ({ project }) => project.id === activeProjectId
  );
  const projectIds = catalog.projects.map(({ project }) => project.id);
  const selectProject = (id: string) => {
    const ordered = orderProjects(projectIds, {
      ...preferences,
      selectedProjectId: id
    });
    void navigateToProject(id);
    void update({
      pinnedProjectIds: ordered.pinnedProjectIds,
      recentProjectIds: ordered.recentProjectIds
    });
  };
  const toggleSidebar = () => {
    void update({
      contextSidebarCollapsed: !preferences.contextSidebarCollapsed
    });
  };
  const commands = useMemo(
    () =>
      buildCommands({
        catalog,
        activeProjectId,
        navigateToProject: selectProject,
        navigateToRoute,
        setTheme,
        toggleSidebar,
        openPreferences,
        signOut
      }),
    [
      catalog,
      activeProjectId,
      preferences,
      navigateToProject,
      navigateToRoute,
      setTheme,
      openPreferences,
      signOut
    ]
  );
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.matches("input, textarea, select, [role='textbox']"))
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openCommands();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openCommands]);
  return (
    <SidebarProvider
      className="h-dvh min-h-0 overflow-hidden"
      open={!preferences.contextSidebarCollapsed}
      onOpenChange={(open) => void update({ contextSidebarCollapsed: !open })}
    >
      <ContextSidebar
        catalog={catalog}
        activeProjectId={activeProjectId}
        activeRoute={activeRoute}
        onNavigate={navigateToRoute}
        onSelectProject={selectProject}
        onOpenCommands={openCommands}
        onOpenPreferences={openPreferences}
      />
      <div className="pointer-events-none fixed inset-x-0 top-0 z-50 hidden h-10 md:block">
        <SidebarTrigger
          aria-label={
            preferences.contextSidebarCollapsed
              ? "Restore sidebar"
              : "Collapse sidebar"
          }
          className="pointer-events-auto absolute left-22 top-1.75"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopToolbar
          context={current}
          collapsed={preferences.contextSidebarCollapsed}
          onOpenCommands={openCommands}
          commandTriggerRef={defaultCommandTriggerRef}
        />
        <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 overflow-auto">
          <ConnectivityBanner />
          {catalog.failures.length ? (
            <div
              role="status"
              className="m-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground"
            >
              Some projects could not be loaded.
              {retryCatalog ? (
                <button
                  type="button"
                  className="font-medium text-foreground underline focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => void retryCatalog()}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {children}
        </main>
      </div>
      <CommandMenu
        open={open}
        onOpenChange={setOpen}
        commands={commands}
        triggerRef={commandInvokerRef}
      />
    </SidebarProvider>
  );
}
