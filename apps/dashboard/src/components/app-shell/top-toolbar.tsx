import { useRef, type MouseEvent, type RefObject, type ReactNode } from "react";
import { Search } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ProjectContext } from "@/features/hierarchy/catalog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

function startWindowDragging() {
  if ("__TAURI_INTERNALS__" in window)
    void getCurrentWindow().startDragging();
}

function toggleWindowMaximize() {
  if ("__TAURI_INTERNALS__" in window)
    void invoke("zoom_window");
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
  collapsed,
  onOpenCommands,
  routeActions,
  commandTriggerRef
}: {
  context?: ProjectContext;
  collapsed: boolean;
  onOpenCommands: () => void;
  routeActions?: ReactNode;
  commandTriggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const dragHandlers = useWindowDragHandlers();
  const shortcut = navigator.platform.toLowerCase().includes("mac")
    ? "⌘ K"
    : "Ctrl K";
  return (
    <header
      className="relative flex h-14 shrink-0 select-none items-center gap-2 border-b px-1 md:h-12 md:px-3"
      onMouseDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("button, a, input, textarea, select, [role='button']")
        )
          return;
        dragHandlers.onMouseDown(event);
      }}
      onMouseMove={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("button, a, input, textarea, select, [role='button']")
        )
          return;
        dragHandlers.onMouseMove(event);
      }}
      onDoubleClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("button, a, input, textarea, select, [role='button']")
        )
          return;
        dragHandlers.onDoubleClick();
      }}
    >
      <WindowDragRegion />
      <div
        className={cn(
          "relative z-10 flex min-w-0 flex-1 items-center gap-2 transition-[padding-left] duration-200 ease-linear",
          collapsed && "md:pl-28"
        )}
      >
        <div
          className={cn(
            "mr-1 h-7 w-px",
            collapsed ? "bg-border" : "bg-transparent"
          )}
        />
        <p className="hidden truncate text-sm text-muted-foreground md:block">
          {context
            ? `${context.organization.name} / ${context.project.name}`
            : ""}
        </p>
        <Button
          ref={commandTriggerRef}
          variant="outline"
          className="ml-auto h-11 md:h-8"
          onClick={onOpenCommands}
        >
          <Search />
          Command{" "}
          <kbd className="hidden text-xs text-muted-foreground sm:inline">
            {shortcut}
          </kbd>
        </Button>
        {routeActions}
      </div>
    </header>
  );
}
