import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  BriefcaseBusiness,
  FileText,
  FolderKanban,
  Gauge,
  MessageSquare,
  MoreHorizontal,
  Search,
  Settings,
  Workflow
} from "lucide-react";
import type { NavigationDestination } from "@/features/command/commands";
import type { ProjectCatalog } from "@/features/hierarchy/catalog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from "@/components/ui/sidebar";

const routeIcons: Record<NavigationDestination, LucideIcon> = {
  overview: Gauge,
  tasks: FolderKanban,
  agents: Bot,
  documents: FileText,
  messages: MessageSquare,
  activity: Activity,
  integrations: Workflow,
  settings: Settings
};

const routeGroups: { label: string; routes: NavigationDestination[] }[] = [
  { label: "Workspace", routes: ["overview", "tasks", "agents"] },
  { label: "Knowledge", routes: ["documents", "messages", "activity"] },
  { label: "Administration", routes: ["integrations", "settings"] }
];

export function ContextSidebar({
  catalog,
  activeProjectId,
  activeRoute = "overview",
  onNavigate,
  onSelectProject,
  onOpenCommands,
  onOpenPreferences
}: {
  catalog: ProjectCatalog;
  activeProjectId?: string;
  activeRoute?: NavigationDestination;
  onNavigate: (route: NavigationDestination) => void;
  onSelectProject: (projectId: string) => void;
  onOpenCommands: () => void;
  onOpenPreferences: () => void;
}) {
  const current = catalog.projects.find(
    ({ project }) => project.id === activeProjectId
  );
  const organizations = Array.from(
    new Map(
      catalog.projects.map((context) => [
        context.organization.id,
        context.organization
      ])
    ).values()
  );

  return (
    <Sidebar collapsible="offcanvas" className="md:bg-sidebar md:pt-8">
      <SidebarContent>
        {routeGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.routes.map((route) => {
                  const Icon = routeIcons[route];
                  return (
                    <SidebarMenuItem key={route}>
                      <SidebarMenuButton
                        isActive={route === activeRoute}
                        asChild
                        tooltip={route[0].toUpperCase() + route.slice(1)}
                        className="bg-transparent hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      >
                        <button
                          type="button"
                          aria-current={
                            route === activeRoute ? "page" : undefined
                          }
                          onClick={() => onNavigate(route)}
                        >
                          <Icon />
                          <span>{route[0].toUpperCase() + route.slice(1)}</span>
                        </button>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={onOpenCommands}
              tooltip="Command palette"
              className="bg-transparent hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Search />
              <span>Command palette</span>
              <span className="ml-auto text-xs text-muted-foreground">⌘K</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={onOpenPreferences}
              tooltip="Preferences"
              className="bg-transparent hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Settings />
              <span>Preferences</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
                {current?.organization.name.slice(0, 1).toUpperCase() ?? "O"}
              </span>
              <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">
                  {current?.organization.name ?? "Organization"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {current
                    ? `${current.workspace.name} / ${current.project.name}`
                    : "Select a project"}
                </span>
              </span>
              <MoreHorizontal className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64" align="start" side="top">
            <DropdownMenuLabel>Organizations</DropdownMenuLabel>
            {organizations.map((organization) => {
              const projects = catalog.projects.filter(
                ({ organization: item }) => item.id === organization.id
              );
              return (
                <DropdownMenuGroup key={organization.id}>
                  <DropdownMenuLabel className="font-normal text-muted-foreground">
                    {organization.name}
                  </DropdownMenuLabel>
                  {projects.map(({ project, workspace }) => (
                    <DropdownMenuItem
                      key={project.id}
                      onSelect={() => onSelectProject(project.id)}
                    >
                      <BriefcaseBusiness />
                      <span className="min-w-0">
                        <span className="block truncate">{project.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {workspace.name}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
