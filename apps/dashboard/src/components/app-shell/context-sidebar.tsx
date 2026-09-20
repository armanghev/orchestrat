import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  ChevronsUpDown,
  FileText,
  FolderKanban,
  Gauge,
  LogOut,
  Search,
  Settings
} from "lucide-react";
import type { NavigationDestination } from "@/features/command/commands";
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
  activeRoute = "overview",
  onNavigate,
  onOpenCommands,
  onOpenPreferences,
  onSignOut,
  profile
}: {
  activeRoute?: NavigationDestination;
  onNavigate: (route: NavigationDestination) => void;
  onOpenCommands: () => void;
  onOpenPreferences: () => void;
  onSignOut: () => void;
  profile?: Profile;
}) {
  const desktop = usePlatform().kind === "desktop";
  const { setOpenMobile } = useSidebar();
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
      <SidebarContent className="gap-2 px-3 py-2">
        {routeGroups.map((group) => (
          <SidebarGroup className="px-0 py-0" key={group.label}>
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

      <SidebarMenu className="shrink-0 p-3">
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={onOpenCommands}
            tooltip="Search"
            className="h-9"
          >
            <Search />
            <span>Search</span>
            <span className="ml-auto text-xs text-muted-foreground">⌘K</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <SidebarFooter className="border-t p-3">
        <SidebarMenu>
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
