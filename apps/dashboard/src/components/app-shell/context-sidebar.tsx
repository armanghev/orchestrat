import type { LucideIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Bot,
  BriefcaseBusiness,
  ChevronsUpDown,
  FileText,
  FolderKanban,
  Gauge,
  LogOut,
  Plus,
  Search,
  Settings
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
  SidebarHeader,
  SidebarTrigger,
  useSidebar,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { usePlatform } from "@/platform/provider";
import { cn } from "@/lib/cn";
import { WindowDragRegion } from "./top-toolbar";

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
  activity: Activity,
  settings: Settings
};
const routeGroups: { label: string; routes: NavigationDestination[] }[] = [
  { label: "Workspace", routes: ["overview", "tasks", "agents"] },
  { label: "Knowledge", routes: ["documents", "activity"] },
  { label: "Administration", routes: ["settings"] }
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
  return (
    <Avatar className={className}>
      {profile?.avatar_url ? (
        <AvatarImage src={profile.avatar_url} alt="" />
      ) : null}
      <AvatarFallback>{label.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
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
  const navigate = useNavigate();
  const desktop = usePlatform().kind === "desktop";
  const { setOpenMobile } = useSidebar();
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
    <Sidebar
      collapsible="offcanvas"
      className={cn("select-none", desktop && "md:pt-12")}
    >
      {desktop ? (
        <div className="absolute inset-x-0 top-0 hidden h-12 border-b bg-sidebar md:block">
          <WindowDragRegion />
        </div>
      ) : null}
      <SidebarHeader className="gap-3 p-3">
        <div className="flex h-8 items-center gap-2.5 px-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            className="size-6 shrink-0 text-brand"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r="8.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray="0.01 4.4406"
            />
            <circle cx="12" cy="12" r="2.75" fill="currentColor" />
          </svg>
          <span className="text-base font-semibold tracking-tight">
            Orchestrat
          </span>
          <SidebarTrigger
            aria-label="Close navigation"
            className="ml-auto md:hidden"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
                {current?.organization.name.slice(0, 1).toUpperCase() ?? "O"}
              </span>
              <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">
                  {current?.organization.name ?? "Organization"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {current ? current.project.name : "Select a project"}
                </span>
              </span>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-64 select-none"
            align="start"
            side="right"
          >
            <DropdownMenuGroup>
              <DropdownMenuItem
                onSelect={() =>
                  window.location.assign("/setup?create=organization")
                }
              >
                <Plus />
                New organization
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => window.location.assign("/setup?create=project")}
              >
                <Plus />
                New project
              </DropdownMenuItem>
              {current ? (
                <DropdownMenuItem
                  onSelect={() =>
                    navigate({
                      to: "/organizations/$organizationId/settings",
                      params: { organizationId: current.organization.id }
                    })
                  }
                >
                  <Settings />
                  Organization settings
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Organizations</DropdownMenuLabel>
            {organizations.map((organization) => (
              <DropdownMenuGroup key={organization.id}>
                <DropdownMenuLabel className="font-normal text-muted-foreground">
                  {organization.name}
                </DropdownMenuLabel>
                {catalog.projects
                  .filter(
                    ({ organization: item }) => item.id === organization.id
                  )
                  .map(({ project }) => (
                    <DropdownMenuItem
                      key={project.id}
                      onSelect={() => {
                        onSelectProject(project.id);
                        setOpenMobile(false);
                      }}
                    >
                      <BriefcaseBusiness />
                      <span className="truncate">{project.name}</span>
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarHeader>
      <Separator />
      <SidebarContent className="gap-2 px-3 py-2">
        {routeGroups.map((group) => (
          <SidebarGroup className="px-0" key={group.label}>
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
                        className="h-9"
                      >
                        <button
                          type="button"
                          aria-current={
                            route === activeRoute ? "page" : undefined
                          }
                          onClick={() => {
                            onNavigate(route);
                            setOpenMobile(false);
                          }}
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

      <SidebarFooter className="border-t p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={onOpenCommands}
              tooltip="Command palette"
              className="h-9"
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
                  className="data-[state=open]:bg-sidebar-accent"
                >
                  <ProfileImage
                    profile={profile}
                    className="size-8 shrink-0 rounded-full"
                  />
                  <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">
                      {profileName}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {profile?.email ?? "Loading profile..."}
                    </span>
                  </span>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-64 select-none"
                align="end"
                side="right"
              >
                <DropdownMenuLabel className="font-normal">
                  <div className="flex items-center gap-3">
                    <ProfileImage
                      profile={profile}
                      className="size-9 shrink-0 rounded-full"
                    />
                    <span className="grid min-w-0 gap-0.5">
                      <span className="truncate font-medium">
                        {profileName}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {profile?.email ?? ""}
                      </span>
                    </span>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={onOpenPreferences}>
                    <Settings />
                    Profile settings
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={onSignOut}
                  >
                    <LogOut />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
