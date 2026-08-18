import type { RefObject, ReactNode } from "react";
import { Search } from "lucide-react";
import type { ProjectContext } from "@/features/hierarchy/catalog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

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
  const shortcut = navigator.platform.toLowerCase().includes("mac")
    ? "⌘ K"
    : "Ctrl K";
  return (
    <header className="relative flex h-14 shrink-0 items-center gap-2 border-b px-1 md:h-12 md:px-3">
      <div
        data-tauri-drag-region
        data-slot="toolbar-drag-region"
        aria-hidden="true"
        className="absolute inset-0"
      />
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
