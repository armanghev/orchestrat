import { useRef, type MouseEvent, type RefObject, type ReactNode } from "react";
import {
  Search,
  Sun,
  Moon,
  Monitor,
  ChevronDown,
  ChevronsUpDown,
  Settings,
  Plus
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Organization } from "@orchestrat/protocol";
import type {
  ProjectCatalog,
  ProjectContext
} from "@/features/hierarchy/catalog";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@tanstack/react-router";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbSeparator
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel
} from "@/components/ui/dropdown-menu";
import { usePlatform } from "@/platform/provider";
import { useTheme } from "@/features/theme/theme-provider";
import type { Theme } from "@/features/theme/theme";
import type { NavigationDestination } from "@/features/command/commands";
import { cn } from "@/lib/cn";

function startWindowDragging() {
  if ("__TAURI_INTERNALS__" in window) void getCurrentWindow().startDragging();
}

function toggleWindowMaximize() {
  if ("__TAURI_INTERNALS__" in window) void invoke("zoom_window");
}

function useWindowDragHandlers() {
  const origin = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);

  return {
    onMouseDown(event: MouseEvent<HTMLElement>) {
      if (event.button !== 0) return;
      origin.current = { x: event.clientX, y: event.clientY };
      dragging.current = false;
    },
    onMouseMove(event: MouseEvent<HTMLElement>) {
      if (!origin.current || dragging.current || event.buttons !== 1) return;
      if (
        Math.hypot(
          event.clientX - origin.current.x,
          event.clientY - origin.current.y
        ) < 3
      )
        return;
      dragging.current = true;
      origin.current = null;
      startWindowDragging();
    },
    onDoubleClick() {
      origin.current = null;
      toggleWindowMaximize();
    }
  };
}

export function WindowDragRegion({ className }: { className?: string }) {
  const dragHandlers = useWindowDragHandlers();
  return (
    <div
      data-tauri-drag-region
      data-slot="toolbar-drag-region"
      aria-hidden="true"
      className={cn("absolute inset-0", className)}
      {...dragHandlers}
    />
  );
}

export type TopToolbarProps = {
  catalog: ProjectCatalog;
  context?: ProjectContext;
  /** Organization pages have an organization but no project. */
  organization?: Organization;
  /** Overrides the page name derived from `activeRoute`. */
  pageTitle?: string;
  onSelectProject: (projectId: string) => void;
  activeRoute?: NavigationDestination;
  collapsed: boolean;
  onOpenCommands: () => void;
  routeActions?: ReactNode;
  commandTriggerRef?: RefObject<HTMLButtonElement | null>;
  /** Organization › Project › Branch › Page. */
  branchMenu?: ReactNode;
};

export function TopToolbar({
  catalog,
  context,
  organization: organizationProp,
  pageTitle,
  onSelectProject,
  activeRoute = "overview",
  collapsed,
  onOpenCommands,
  routeActions,
  commandTriggerRef,
  branchMenu
}: TopToolbarProps) {
  const navigate = useNavigate();
  const dragHandlers = useWindowDragHandlers();
  const desktop = usePlatform().kind === "desktop";
  const { isMobile, openMobile } = useSidebar();
  const { theme, setTheme } = useTheme();
  const organization = context?.organization ?? organizationProp;
  const openOrganization = (organizationId: string) =>
    void navigate({
      to: "/organizations/$organizationId",
      params: { organizationId }
    });
  const shortcut = navigator.platform.toLowerCase().includes("mac")
    ? "⌘K"
    : "Ctrl K";
  return (
    <header
      data-slot="top-toolbar"
      className={cn(
        "relative flex h-14 shrink-0 select-none items-center gap-3 border-b px-4 sm:px-6",
        desktop && "md:h-12 md:bg-sidebar",
        desktop && collapsed && "md:-ml-12 md:w-[calc(100%+3rem)] md:pl-18"
      )}
      onMouseDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(
            "button, a, input, textarea, select, [role='button']"
          )
        )
          return;
        dragHandlers.onMouseDown(event);
      }}
      onMouseMove={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(
            "button, a, input, textarea, select, [role='button']"
          )
        )
          return;
        dragHandlers.onMouseMove(event);
      }}
      onDoubleClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(
            "button, a, input, textarea, select, [role='button']"
          )
        )
          return;
        dragHandlers.onDoubleClick();
      }}
    >
      <WindowDragRegion />
      <div
        className={cn(
          "relative z-10 flex min-w-0 flex-1 items-center gap-2 transition-[padding-left] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          desktop && collapsed && "md:pl-16"
        )}
      >
        <div className="flex min-w-0 items-center">
          <SidebarTrigger
            aria-label={
              isMobile
                ? openMobile
                  ? "Close navigation"
                  : "Open navigation"
                : collapsed
                  ? "Restore sidebar"
                  : "Collapse sidebar"
            }
            className={cn("mr-3", desktop && "md:hidden")}
          />
          <Separator
            orientation="vertical"
            className={cn(
              "mr-4 h-5 data-[orientation=vertical]:self-center transition-[width,margin,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
              desktop &&
                !collapsed &&
                "md:mr-0 md:opacity-0 md:data-[orientation=vertical]:w-0"
            )}
          />
          <Breadcrumb className="min-w-0">
            <BreadcrumbList className="flex-nowrap">
              {organization ? (
                <>
                  <BreadcrumbItem className="hidden min-w-0 gap-0 sm:inline-flex">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={"Organization: " + organization.name}
                      className="w-max max-w-full min-w-0 px-1.5 font-normal text-muted-foreground hover:text-primary-text"
                      onClick={() => openOrganization(organization.id)}
                    >
                      <span className="truncate">{organization.name}</span>
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Switch organization"
                          className="text-muted-foreground hover:text-primary-text data-[state=open]:text-primary-text"
                        >
                          <ChevronsUpDown />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="w-64" align="start">
                        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={organization.id}
                          onValueChange={openOrganization}
                        >
                          {catalog.organizations.map((item) => (
                            <DropdownMenuRadioItem
                              key={item.id}
                              value={item.id}
                            >
                              <span className="truncate">{item.name}</span>
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() =>
                            void navigate({
                              to: "/organizations/new",
                              search: { fromOrganization: organization.id }
                            })
                          }
                        >
                          <Plus />
                          New organization
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            void navigate({
                              to: "/organizations/$organizationId/settings",
                              params: { organizationId: organization.id }
                            })
                          }
                        >
                          <Settings />
                          Organization settings
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden sm:block" />
                </>
              ) : null}
              {context ? (
                <>
                  <BreadcrumbItem className="hidden min-w-0 sm:inline-flex">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={"Project: " + context.project.name}
                          className="w-max max-w-full min-w-0 px-1.5 font-normal text-muted-foreground hover:text-primary-text data-[state=open]:text-primary-text"
                        >
                          <span className="truncate">
                            {context.project.name}
                          </span>
                          <ChevronDown className="size-3" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="w-64" align="start">
                        <DropdownMenuLabel>Projects</DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={context.project.id}
                          onValueChange={onSelectProject}
                        >
                          {catalog.projects
                            .filter(
                              ({ organization }) =>
                                organization.id === context.organization.id
                            )
                            .map(({ project }) => (
                              <DropdownMenuRadioItem
                                key={project.id}
                                value={project.id}
                              >
                                <span className="truncate">{project.name}</span>
                              </DropdownMenuRadioItem>
                            ))}
                        </DropdownMenuRadioGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() =>
                            void navigate({
                              to: "/organizations/$organizationId/projects/new",
                              params: {
                                organizationId: context.organization.id
                              }
                            })
                          }
                        >
                          <Plus />
                          New project
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            void navigate({
                              to: "/projects/$projectId/settings",
                              params: { projectId: context.project.id }
                            })
                          }
                        >
                          <Settings />
                          Project settings
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden sm:block" />
                  {branchMenu ? (
                    <>
                      <BreadcrumbItem className="hidden min-w-0 sm:inline-flex">
                        {branchMenu}
                      </BreadcrumbItem>
                      <BreadcrumbSeparator className="hidden sm:block" />
                    </>
                  ) : null}
                </>
              ) : null}
              <BreadcrumbItem>
                <h1
                  data-slot="top-toolbar-page"
                  tabIndex={-1}
                  aria-current="page"
                  className="text-sm font-normal text-primary-text outline-none"
                >
                  {pageTitle ??
                    activeRoute[0].toUpperCase() + activeRoute.slice(1)}
                </h1>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {routeActions}
        </div>
        <Button
          ref={commandTriggerRef}
          variant="outline"
          aria-label="Search"
          onClick={onOpenCommands}
        >
          <Search data-icon="inline-start" />
          <kbd className="hidden text-sm text-muted-foreground sm:inline">
            {shortcut}
          </kbd>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Appearance">
              <Sun />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value) => void setTheme(value as Theme)}
            >
              <DropdownMenuRadioItem value="light">
                <Sun />
                Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon />
                Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor />
                System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
