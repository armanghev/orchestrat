import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProjectCatalog } from "@/features/hierarchy/catalog";
import { buildCommands, type NavigationDestination } from "@/features/command/commands";
import { orderProjects } from "@/features/hierarchy/project-order";
import { useTheme } from "@/features/theme/theme-provider";
import { usePreferences } from "@/platform/preferences-provider";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { GlobalRail } from "./global-rail";
import { ContextSidebar } from "./context-sidebar";
import { TopToolbar } from "./top-toolbar";
import { CommandMenu } from "./command-menu";

export type AppShellProps = {
  catalog: ProjectCatalog;
  activeProjectId?: string;
  activeRoute?: NavigationDestination;
  navigateToProject: (projectId: string) => void | Promise<void>;
  navigateToRoute: (route: NavigationDestination, projectId?: string) => void | Promise<void>;
  openPreferences: () => void | Promise<void>;
  signOut: () => void | Promise<void>;
  retryCatalog?: () => void | Promise<void>;
  children: ReactNode;
};

export function AppShell({ catalog, activeProjectId, activeRoute = "overview", navigateToProject, navigateToRoute, openPreferences, signOut, retryCatalog, children }: AppShellProps) {
  const { preferences, update } = usePreferences();
  const { setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [openCommandsAfterMobileNavigation, setOpenCommandsAfterMobileNavigation] = useState(false);
  const commandInvokerRef = useRef<HTMLElement>(null);
  const defaultCommandTriggerRef = useRef<HTMLButtonElement>(null);
  const openCommands = useCallback(() => {
    const activeElement = document.activeElement;
    commandInvokerRef.current = activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : defaultCommandTriggerRef.current;
    setOpen(true);
  }, []);
  const current = catalog.projects.find(({ project }) => project.id === activeProjectId);
  const projectIds = catalog.projects.map(({ project }) => project.id);
  const selectProject = (id: string) => {
    const ordered = orderProjects(projectIds, { ...preferences, selectedProjectId: id });
    void navigateToProject(id);
    void update({ pinnedProjectIds: ordered.pinnedProjectIds, recentProjectIds: ordered.recentProjectIds });
  };
  const togglePin = (id: string) => {
    const ordered = orderProjects(projectIds, preferences);
    const pinned = ordered.pinnedProjectIds.includes(id);
    void update({
      pinnedProjectIds: pinned ? ordered.pinnedProjectIds.filter((value) => value !== id) : [id, ...ordered.pinnedProjectIds.filter((value) => value !== id)].slice(0, 8),
      recentProjectIds: ordered.recentProjectIds.filter((value) => value !== id)
    });
  };
  const toggleSidebar = () => { void update({ contextSidebarCollapsed: !preferences.contextSidebarCollapsed }); };
  const commands = useMemo(() => buildCommands({ catalog, activeProjectId, navigateToProject: selectProject, navigateToRoute, setTheme, toggleSidebar, openPreferences, signOut }), [catalog, activeProjectId, preferences, navigateToProject, navigateToRoute, setTheme, openPreferences, signOut]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openCommands(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openCommands]);
  useEffect(() => {
    if (!mobileNavigationOpen && openCommandsAfterMobileNavigation) {
      setOpenCommandsAfterMobileNavigation(false);
      setOpen(true);
    }
  }, [mobileNavigationOpen, openCommandsAfterMobileNavigation]);
  const closeMobileNavigation = () => setMobileNavigationOpen(false);
  const openMobileCommands = () => {
    commandInvokerRef.current = defaultCommandTriggerRef.current;
    closeMobileNavigation();
    setOpenCommandsAfterMobileNavigation(true);
  };
  return <div className={`grid h-dvh grid-cols-[minmax(0,1fr)] overflow-hidden bg-background md:grid-cols-[64px_${preferences.contextSidebarCollapsed ? "0px" : "240px"}_minmax(0,1fr)]`}>
    <GlobalRail catalog={catalog} activeProjectId={activeProjectId} onOpenProject={selectProject} onOpenCommands={openCommands} onOpenPreferences={openPreferences} onTogglePin={togglePin} />
    <ContextSidebar catalog={catalog} activeProjectId={activeProjectId} activeRoute={activeRoute} collapsed={preferences.contextSidebarCollapsed} onNavigate={navigateToRoute} />
    <div className="grid min-w-0 grid-rows-[56px_minmax(0,1fr)] md:grid-rows-[48px_minmax(0,1fr)]"><TopToolbar context={current} collapsed={preferences.contextSidebarCollapsed} onToggleSidebar={toggleSidebar} onOpenCommands={openCommands} onOpenMobileNavigation={() => setMobileNavigationOpen(true)} commandTriggerRef={defaultCommandTriggerRef} />
      <main id="main-content" tabIndex={-1} className="min-h-0 overflow-auto">{catalog.failures.length ? <div role="status" className="m-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground">Some projects could not be loaded.{retryCatalog ? <button type="button" className="font-medium text-foreground underline focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void retryCatalog()}>Retry</button> : null}</div> : null}{children}</main>
    </div>
    <Sheet open={mobileNavigationOpen} onOpenChange={setMobileNavigationOpen}><SheetContent side="left" className="w-[calc(100vw-1rem)] max-w-80 gap-0 p-0" aria-describedby={undefined}><SheetHeader><SheetTitle>Workspace navigation</SheetTitle></SheetHeader>
      <div className="flex min-h-0 flex-1 overflow-hidden"><GlobalRail mobile catalog={catalog} activeProjectId={activeProjectId} onOpenProject={(id) => { selectProject(id); closeMobileNavigation(); }} onOpenCommands={openMobileCommands} onOpenPreferences={() => { void openPreferences(); closeMobileNavigation(); }} onTogglePin={togglePin} />
        <ContextSidebar mobile catalog={catalog} activeProjectId={activeProjectId} activeRoute={activeRoute} collapsed={false} onNavigate={(route) => { void navigateToRoute(route); closeMobileNavigation(); }} />
      </div>
    </SheetContent></Sheet>
    <CommandMenu open={open} onOpenChange={setOpen} commands={commands} triggerRef={commandInvokerRef} />
  </div>;
}
