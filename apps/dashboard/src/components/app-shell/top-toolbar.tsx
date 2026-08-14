import type { RefObject, ReactNode } from "react";
import { Menu, PanelLeft, Search } from "lucide-react";
import type { ProjectContext } from "@/features/hierarchy/catalog";
import { Button } from "@/components/ui/button";

export function TopToolbar({ context, collapsed, onToggleSidebar, onOpenCommands, onOpenMobileNavigation, routeActions, commandTriggerRef }: { context?: ProjectContext; collapsed: boolean; onToggleSidebar: () => void; onOpenCommands: () => void; onOpenMobileNavigation: () => void; routeActions?: ReactNode; commandTriggerRef?: RefObject<HTMLButtonElement | null> }) {
  const shortcut = navigator.platform.toLowerCase().includes("mac") ? "⌘ K" : "Ctrl K";
  return <header className="relative flex h-full items-center gap-2 border-b px-1 md:px-3"><div data-tauri-drag-region data-slot="toolbar-drag-region" aria-hidden="true" className="absolute inset-0" />
    <div className="relative z-10 flex min-w-0 flex-1 items-center gap-2"><Button variant="ghost" size="icon" className="size-11 md:hidden" aria-label="Open navigation" onClick={onOpenMobileNavigation}><Menu /></Button>
      <Button variant="ghost" size="icon-sm" className="hidden md:inline-flex" aria-label={collapsed ? "Restore sidebar" : "Collapse sidebar"} onClick={onToggleSidebar}><PanelLeft /></Button>
      <p className="hidden truncate text-sm text-muted-foreground md:block">{context ? `${context.organization.name} / ${context.workspace.name} / ${context.project.name}` : ""}</p>
      <Button ref={commandTriggerRef} variant="outline" className="ml-auto h-11 md:h-8" onClick={onOpenCommands}><Search />Command <kbd className="hidden text-xs text-muted-foreground sm:inline">{shortcut}</kbd></Button>
      {routeActions}
    </div>
  </header>;
}
