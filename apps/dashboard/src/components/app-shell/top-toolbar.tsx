import { useRef, type MouseEvent, type RefObject, type ReactNode } from "react";
import { Search, Sun, Moon, Monitor } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ProjectContext } from "@/features/hierarchy/catalog";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
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

export function TopToolbar({
  context,
  activeRoute = "overview",
  collapsed,
  onOpenCommands,
  routeActions,
  commandTriggerRef
}: {
  context?: ProjectContext;
  activeRoute?: NavigationDestination;
  collapsed: boolean;
  onOpenCommands: () => void;
  routeActions?: ReactNode;
  commandTriggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const dragHandlers = useWindowDragHandlers();
  const desktop = usePlatform().kind === "desktop";
  const { isMobile, openMobile } = useSidebar();
  const { theme, setTheme } = useTheme();
  const shortcut = navigator.platform.toLowerCase().includes("mac")
    ? "⌘ K"
    : "Ctrl K";
  return (
    <header
      className={cn(
        "relative flex h-14 shrink-0 select-none items-center gap-3 border-b px-4 sm:px-6",
        desktop && "md:h-12 md:bg-sidebar"
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
          desktop && collapsed && "md:pl-28"
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
              {context ? (
                <>
                  <BreadcrumbItem className="hidden min-w-0 sm:inline-flex">
                    <BreadcrumbLink asChild>
                      <Link
                        to="/projects/$projectId/overview"
                        params={{ projectId: context.project.id }}
                        className="truncate"
                      >
                        {context.project.name}
                      </Link>
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator className="hidden sm:block" />
                </>
              ) : null}
              <BreadcrumbItem>
                <BreadcrumbPage className="text-primary-text">
                  {activeRoute[0].toUpperCase() + activeRoute.slice(1)}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
        <Button
          ref={commandTriggerRef}
          variant="outline"
          className="ml-auto"
          onClick={onOpenCommands}
        >
          <Search data-icon="inline-start" />
          Command{" "}
          <kbd className="hidden text-xs text-muted-foreground sm:inline">
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
        {routeActions}
      </div>
    </header>
  );
}
