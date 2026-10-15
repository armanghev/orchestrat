import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Organization } from "@orchestrat/protocol";
import type { ProjectCatalog } from "@/features/hierarchy/catalog";
import {
  buildCommands,
  type BuildCommandsOptions,
  type NavigationDestination,
  type OrganizationDestination
} from "@/features/command/commands";
import { orderProjects } from "@/features/hierarchy/project-order";
import { useTheme } from "@/features/theme/theme-provider";
import { usePreferences } from "@/platform/preferences-provider";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { ContextSidebar, OrganizationSidebar } from "./context-sidebar";
import { TopToolbar, type TopToolbarProps } from "./top-toolbar";
import { CommandMenu } from "./command-menu";
import { usePlatform } from "@/platform/provider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConnectivityBanner } from "@/features/connectivity/connectivity-banner";
import { WindowDragRegion } from "./top-toolbar";
import type { ApiClient } from "@/lib/api/client";
import { inboxQueryOptions } from "@/features/messaging/query-options";
import {
  attentionSummaryQueryOptions,
  taskCommentCounts
} from "@/features/attention/query-options";
import { useOptionalBranch } from "@/features/branches/branch-context";
import { BranchSelector } from "@/features/branches/branch-selector";
import { ArchivedBranchBanner } from "@/features/branches/archived-banner";
import { BranchOnboardingPanel } from "@/features/branches/onboarding-panel";

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

type Profile = {
  username: string | null;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
};

type ShellCommandOptions = Omit<
  BuildCommandsOptions,
  "catalog" | "setTheme" | "toggleSidebar" | "openPreferences" | "signOut"
>;

/** The frame every signed-in page with navigation shares: the collapsible
 * sidebar, the toolbar, the main region with shell banners, and ⌘K search. */
function ShellFrame({
  catalog,
  navigationLabel,
  sidebar,
  toolbar,
  banners,
  commandOptions,
  openPreferences,
  signOut,
  retryCatalog,
  children
}: {
  catalog: ProjectCatalog;
  navigationLabel: string;
  sidebar: (openCommands: () => void) => ReactNode;
  toolbar: Omit<
    TopToolbarProps,
    | "catalog"
    | "onOpenCommands"
    | "collapsed"
    | "routeActions"
    | "commandTriggerRef"
  >;
  banners?: ReactNode;
  commandOptions: ShellCommandOptions;
  openPreferences: () => void | Promise<void>;
  signOut: () => void | Promise<void>;
  retryCatalog?: () => void | Promise<void>;
  children: ReactNode;
}) {
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
  const toggleSidebar = () => {
    void update({
      contextSidebarCollapsed: !preferences.contextSidebarCollapsed
    });
  };
  const commands = buildCommands({
    ...commandOptions,
    catalog,
    setTheme,
    toggleSidebar,
    openPreferences,
    signOut
  });
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
      <aside aria-label={navigationLabel} className="contents">
        {sidebar(openCommands)}
      </aside>
      <div className="flex w-full min-w-0 flex-1 flex-col">
        <TopToolbar
          {...toolbar}
          catalog={catalog}
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
          {banners}
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
  navigateToOrganization?: (
    organizationId: string,
    destination: OrganizationDestination
  ) => void | Promise<void>;
  openPreferences: () => void | Promise<void>;
  signOut: () => void | Promise<void>;
  profile?: Profile;
  retryCatalog?: () => void | Promise<void>;
  children: ReactNode;
};

/** Project pages: project navigation, Organization › Project › Branch. */
export function AppShell({
  catalog,
  api,
  activeProjectId,
  activeRoute = "overview",
  navigateToProject,
  navigateToRoute,
  navigateToOrganization,
  openPreferences,
  signOut,
  profile,
  retryCatalog,
  children
}: AppShellProps) {
  const { preferences, update } = usePreferences();
  const current = catalog.projects.find(
    ({ project }) => project.id === activeProjectId
  );
  const branchContext = useOptionalBranch();
  // The sidebar's Messages badge counts the branch on screen (spec §11.3).
  const inboxQueries = useQueries({
    queries: catalog.projects.map(({ project }) =>
      inboxQueryOptions(
        api,
        project.id,
        project.id === activeProjectId ? branchContext?.branchId : undefined
      )
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
  const attention = useQuery({
    ...attentionSummaryQueryOptions(api, activeProjectId ?? ""),
    enabled: Boolean(current)
  });
  const taskCounts = taskCommentCounts(current ? attention.data : undefined);
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
  return (
    <ShellFrame
      catalog={catalog}
      navigationLabel="Project navigation"
      sidebar={(openCommands) => (
        <ContextSidebar
          activeRoute={activeRoute}
          onNavigate={navigateToRoute}
          onOpenCommands={openCommands}
          onOpenPreferences={openPreferences}
          onSignOut={signOut}
          profile={profile}
          messageCounts={messageCounts}
          taskCounts={taskCounts}
          decisionCount={branchContext?.branch.open_decision_count}
        />
      )}
      toolbar={{
        context: current,
        onSelectProject: selectProject,
        activeRoute,
        branchMenu: branchContext ? <BranchSelector api={api} /> : null
      }}
      banners={
        <>
          <ArchivedBranchBanner />
          <BranchOnboardingPanel api={api} />
        </>
      }
      commandOptions={{
        activeProjectId,
        navigateToOrganization,
        navigateToProject: selectProject,
        navigateToRoute,
        branches: branchContext
          ? {
              branches: branchContext.branches,
              currentBranchId: branchContext.branchId,
              canCreate: !branchContext.projectArchived,
              selectBranch: branchContext.selectBranch,
              openCreateBranch: branchContext.openCreateBranch
            }
          : undefined
      }}
      openPreferences={openPreferences}
      signOut={signOut}
      retryCatalog={retryCatalog}
    >
      {children}
    </ShellFrame>
  );
}

const organizationPageTitles: Record<OrganizationDestination, string> = {
  projects: "Projects",
  members: "Members",
  settings: "Settings"
};

/** Organization pages: Projects, Members, Settings; Organization › Page. */
export function OrganizationShell({
  catalog,
  organization,
  activeDestination,
  pageTitle,
  navigateToOrganization,
  navigateToProject,
  openPreferences,
  signOut,
  profile,
  retryCatalog,
  children
}: {
  catalog: ProjectCatalog;
  organization: Organization;
  /** Undefined on pages outside the sidebar's three, which pass a title. */
  activeDestination?: OrganizationDestination;
  pageTitle?: string;
  navigateToOrganization: (
    organizationId: string,
    destination: OrganizationDestination
  ) => void | Promise<void>;
  navigateToProject: (projectId: string) => void | Promise<void>;
  openPreferences: () => void | Promise<void>;
  signOut: () => void | Promise<void>;
  profile?: Profile;
  retryCatalog?: () => void | Promise<void>;
  children: ReactNode;
}) {
  return (
    <ShellFrame
      catalog={catalog}
      navigationLabel="Organization navigation"
      sidebar={(openCommands) => (
        <OrganizationSidebar
          activeDestination={activeDestination}
          onNavigate={(destination) =>
            void navigateToOrganization(organization.id, destination)
          }
          onOpenCommands={openCommands}
          onOpenPreferences={openPreferences}
          onSignOut={signOut}
          profile={profile}
        />
      )}
      toolbar={{
        organization,
        onSelectProject: (id) => void navigateToProject(id),
        pageTitle:
          pageTitle ?? organizationPageTitles[activeDestination ?? "projects"]
      }}
      commandOptions={{
        activeOrganizationId: organization.id,
        navigateToOrganization,
        navigateToProject,
        navigateToRoute: (_route, projectId) =>
          projectId ? navigateToProject(projectId) : undefined
      }}
      openPreferences={openPreferences}
      signOut={signOut}
      retryCatalog={retryCatalog}
    >
      {children}
    </ShellFrame>
  );
}
