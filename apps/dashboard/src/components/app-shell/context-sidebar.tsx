import { navigationDestinations, type NavigationDestination } from "@/features/command/commands";
import type { ProjectCatalog } from "@/features/hierarchy/catalog";
import { cn } from "@/lib/cn";

export function ContextSidebar({ catalog, activeProjectId, activeRoute = "overview", collapsed, onNavigate, mobile = false }: {
  catalog: ProjectCatalog; activeProjectId?: string; activeRoute?: NavigationDestination; collapsed: boolean;
  onNavigate: (route: NavigationDestination) => void; mobile?: boolean;
}) {
  const current = catalog.projects.find(({ project }) => project.id === activeProjectId);
  return <aside aria-label="Project navigation" aria-hidden={collapsed || undefined} inert={collapsed ? true : undefined}
    className={cn("min-w-0 overflow-hidden border-r bg-background transition-[width]", mobile ? "block w-60" : "hidden md:block", collapsed ? "w-0" : "w-60")}>
    <div className="w-60 p-3"><header className="border-b pb-3"><p className="truncate font-medium">{current?.project.name ?? "Project"}</p><p className="truncate text-sm text-muted-foreground">{current ? `${current.organization.name} / ${current.workspace.name}` : ""}</p></header>
      <nav aria-label="Project routes" className="mt-3 space-y-1">{navigationDestinations.map((route) => <button key={route} type="button" aria-current={route === activeRoute ? "page" : undefined} onClick={() => onNavigate(route)} className={cn("flex w-full rounded-md px-3 py-2 text-left text-sm capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring", mobile && "h-11", route === activeRoute ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}>{route[0].toUpperCase() + route.slice(1)}</button>)}</nav>
    </div>
  </aside>;
}
