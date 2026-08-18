import { useState } from "react";
import { MoreHorizontal, Settings } from "lucide-react";
import type { ProjectCatalog } from "@/features/hierarchy/catalog";
import { orderProjects } from "@/features/hierarchy/project-order";
import { usePreferences } from "@/platform/preferences-provider";
import { usePlatform } from "@/platform/provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { ProjectMark } from "./project-mark";

export function GlobalRail({
  catalog,
  activeProjectId,
  onOpenProject,
  onOpenCommands,
  onOpenPreferences,
  onTogglePin,
  mobile = false
}: {
  catalog: ProjectCatalog;
  activeProjectId?: string;
  onOpenProject: (id: string) => void;
  onOpenCommands: () => void;
  onOpenPreferences: () => void;
  onTogglePin: (id: string) => void;
  mobile?: boolean;
}) {
  const { preferences } = usePreferences();
  const platform = usePlatform();
  const order = orderProjects(
    catalog.projects.map(({ project }) => project.id),
    { ...preferences, selectedProjectId: activeProjectId }
  );
  const byId = new Map(
    catalog.projects.map((context) => [context.project.id, context])
  );
  const [contextProjectId, setContextProjectId] = useState<string | null>(null);
  const controlSize = mobile ? "icon" : "icon-sm";
  return (
    <aside
      aria-label="Projects"
      className={cn(
        "w-16 shrink-0 flex-col items-center border-r bg-rail",
        mobile
          ? "flex h-full pt-2"
          : `hidden md:flex ${platform.kind === "desktop" ? "pt-11" : "pt-2"}`
      )}
    >
      <nav
        aria-label="Project shortcuts"
        className="flex flex-1 flex-col items-center gap-2 py-2"
      >
        {order.visible.map((id) => {
          const context = byId.get(id)!;
          const active = id === activeProjectId;
          const pinned = order.pinnedProjectIds.includes(id);
          return (
            <div key={id} className="flex flex-col items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={`/projects/${id}/overview`}
                    aria-label={`Open ${context.project.name}`}
                    aria-current={active ? "page" : undefined}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setContextProjectId(id);
                    }}
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      onOpenProject(id);
                    }}
                    className={cn(
                      "flex size-11 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted"
                    )}
                  >
                    <ProjectMark name={context.project.name} active={active} />
                  </a>
                </TooltipTrigger>
                <TooltipContent>{context.project.name}</TooltipContent>
              </Tooltip>
              <DropdownMenu
                open={contextProjectId === id}
                onOpenChange={(open) => setContextProjectId(open ? id : null)}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size={controlSize}
                        className={mobile ? "size-11" : undefined}
                        aria-label={`Project options for ${context.project.name}`}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent>Project options</TooltipContent>
                </Tooltip>
                <DropdownMenuContent>
                  <DropdownMenuItem
                    className={mobile ? "h-11 px-3" : undefined}
                    onSelect={() => onTogglePin(id)}
                  >
                    {pinned ? "Unpin project" : "Pin project"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </nav>
      <div className="flex flex-col gap-1 pb-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size={controlSize}
              className={mobile ? "size-11" : undefined}
              aria-label="Open command palette"
              onClick={onOpenCommands}
            >
              <MoreHorizontal />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Search projects and commands</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size={controlSize}
              className={mobile ? "size-11" : undefined}
              aria-label="Open preferences"
              onClick={onOpenPreferences}
            >
              <Settings />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Preferences</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
