import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  BriefcaseBusiness,
  ChevronsUpDown,
  FileText,
  FolderKanban,
  Gauge,
  LogOut,
  MessageSquare,
  Plus,
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
  DropdownMenuSeparator,
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

type Profile = {
  username: string | null;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
};

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

function ProfileImage({
  profile,
  className
}: {
  profile?: Profile;
  className: string;
}) {
  const label =
    profile?.full_name ?? profile?.username ?? profile?.email ?? "Account";
  if (profile?.avatar_url)
    return <img src={profile.avatar_url} alt="" className={`${className} object-cover`} />;
  return (
    <span
      className={`${className} flex items-center justify-center bg-primary text-sm font-semibold text-primary-foreground`}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ContextSidebar({
  catalog,
  activeProjectId,
  activeRoute = "overview",
  onNavigate,
  onSelectProject,
  onOpenCommands,
  onOpenPreferences,
  onSignOut,
  profile
}: {
  catalog: ProjectCatalog;
  activeProjectId?: string;
  activeRoute?: NavigationDestination;
  onNavigate: (route: NavigationDestination) => void;
  onSelectProject: (projectId: string) => void;
  onOpenCommands: () => void;
  onOpenPreferences: () => void;
  onSignOut: () => void;
  profile?: Profile;
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
  const profileName =
    profile?.full_name ?? profile?.username ?? profile?.email ?? "Account";

  return (
    <Sidebar collapsible="offcanvas" className="md:bg-sidebar md:pt-8">
      <div className="px-2 pt-2">
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
                    ? current.project.name
                    : "Select a project"}
                </span>
              </span>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64" align="start" side="right">
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => window.location.assign("/setup?create=organization")}>
                <Plus />
                New organization
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => window.location.assign("/setup?create=project")}>
                <Plus />
                New project
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Organizations</DropdownMenuLabel>
            {organizations.map((organization) => (
              <DropdownMenuGroup key={organization.id}>
                <DropdownMenuLabel className="font-normal text-muted-foreground">
                  {organization.name}
                </DropdownMenuLabel>
                {catalog.projects
                  .filter(({ organization: item }) => item.id === organization.id)
                  .map(({ project }) => (
                    <DropdownMenuItem
                      key={project.id}
                      onSelect={() => onSelectProject(project.id)}
                    >
                      <BriefcaseBusiness />
                      <span className="truncate">{project.name}</span>
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

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
                          aria-current={route === activeRoute ? "page" : undefined}
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <ProfileImage profile={profile} className="size-8 shrink-0 rounded-full" />
                  <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">{profileName}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {profile?.email ?? "Loading profile..."}
                    </span>
                  </span>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-64" align="end" side="right">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex items-center gap-3">
                    <ProfileImage profile={profile} className="size-9 shrink-0 rounded-full" />
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate font-medium">{profileName}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {profile?.email ?? ""}
                      </span>
                    </span>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onOpenPreferences}>
                  <Settings />
                  Profile settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onSignOut}>
                  <LogOut />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
