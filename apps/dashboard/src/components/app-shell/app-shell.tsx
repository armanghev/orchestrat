import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { useQueries } from "@tanstack/react-query";
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
import { usePlatform } from "@/platform/provider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConnectivityBanner } from "@/features/connectivity/connectivity-banner";
import { WindowDragRegion } from "./top-toolbar";
import type { ApiClient } from "@/lib/api/client";
import { inboxQueryOptions } from "@/features/messaging/query-options";

const TopToolbarActionsContext = createContext<
  ((actions: ReactNode | null) => void) | null
>(null);

export function TopToolbarActions({ children }: { children: ReactNode }) {
  const setActions = useContext(TopToolbarActionsContext);
  useEffect(() => {
    setActions?.(children);
    return () => setActions?.(null);
  }, [children, setActions]);
  return null;
}

export type AppShellProps = {
  catalog: ProjectCatalog;
  api: ApiClient;
  activeProjectId?: string;
  activeRoute?: NavigationDestination;
  navigateToProject: (projectId: string) => void | Promise<void>;
  navigateToRoute: (
    route: NavigationDestination,
    projectId?: string
  ) => void | Promise<void>;
  openPreferences: () => void | Promise<void>;
  signOut: () => void | Promise<void>;
  profile?: {
    username: string | null;
    full_name: string | null;
    email: string;
    avatar_url: string | null;
  };
  retryCatalog?: () => void | Promise<void>;
  children: ReactNode;
};

export function AppShell({
  catalog,
  api,
  activeProjectId,
  activeRoute = "overview",
  navigateToProject,
  navigateToRoute,
  openPreferences,
  signOut,
  profile,
  retryCatalog,
  children
}: AppShellProps) {
  const { preferences, update } = usePreferences();
  const desktop = usePlatform().kind === "desktop";
  const { setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [routeActions, setRouteActions] = useState<ReactNode>(null);
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
  const inboxQueries = useQueries({
    queries: catalog.projects.map(({ project }) =>
      inboxQueryOptions(api, project.id)
    )
  });
  const currentInbox =
    inboxQueries[
      catalog.projects.findIndex(
        ({ project }) => project.id === activeProjectId
      )
    ]?.data;
  const messageCounts = currentInbox?.unread_chats.reduce(
    (counts, chat) => ({
      unread: counts.unread + chat.unread_count,
      mentions: counts.mentions + chat.mention_count
    }),
    { unread: 0, mentions: 0 }
  ) ?? { unread: 0, mentions: 0 };
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
      className="h-full min-h-0 overflow-hidden"
      open={!preferences.contextSidebarCollapsed}
      onOpenChange={(open) => void update({ contextSidebarCollapsed: !open })}
    >
      <a
        href="#main-content"
        className="sr-only fixed left-4 top-4 z-50 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground focus:not-sr-only"
      >
        Skip to content
      </a>
      {desktop ? (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-50 hidden h-12 items-center md:flex">
          <WindowDragRegion />
          <SidebarTrigger
            aria-label={
              preferences.contextSidebarCollapsed
                ? "Restore sidebar"
                : "Collapse sidebar"
            }
            className="pointer-events-auto relative left-22"
          />
        </div>
      ) : null}
      <aside aria-label="Project navigation" className="contents">
        <ContextSidebar
          activeRoute={activeRoute}
          onNavigate={navigateToRoute}
          onOpenCommands={openCommands}
          onOpenPreferences={openPreferences}
          onSignOut={signOut}
          profile={profile}
          messageCounts={messageCounts}
        />
      </aside>
      <div className="flex w-full min-w-0 flex-1 flex-col">
        <TopToolbar
          catalog={catalog}
          context={current}
          onSelectProject={selectProject}
          activeRoute={activeRoute}
          onOpenCommands={openCommands}
          collapsed={preferences.contextSidebarCollapsed}
          routeActions={routeActions}
          commandTriggerRef={defaultCommandTriggerRef}
        />
        <main
          id="main-content"
          tabIndex={0}
          className="min-h-0 flex-1 overflow-auto"
        >
          <ConnectivityBanner />
          {catalog.failures.length ? (
            <Alert role="status" className="m-4 w-auto">
              <AlertDescription>
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
              </AlertDescription>
            </Alert>
          ) : null}
          <TopToolbarActionsContext.Provider value={setRouteActions}>
            {children}
          </TopToolbarActionsContext.Provider>
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
