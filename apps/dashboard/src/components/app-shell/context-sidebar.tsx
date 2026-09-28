import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Bot,
  ChevronsUpDown,
  FileText,
  FolderKanban,
  Gauge,
  LogOut,
  MessagesSquare,
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
  useSidebar,
  SidebarFooter,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
  messages: MessagesSquare,
  activity: Activity,
  settings: Settings
};
const routeGroups: { label: string; routes: NavigationDestination[] }[] = [
  { label: "Workspace", routes: ["overview", "tasks", "agents", "messages"] },
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
  profile,
  messageCounts
}: {
  activeRoute?: NavigationDestination;
  onNavigate: (route: NavigationDestination) => void;
  onOpenCommands: () => void;
  onOpenPreferences: () => void;
  onSignOut: () => void;
  profile?: Profile;
  messageCounts?: { unread: number; mentions: number };
}) {
  const desktop = usePlatform().kind === "desktop";
  const { setOpenMobile, state } = useSidebar();
  const [desktopBorderReady, setDesktopBorderReady] = useState(
    state === "expanded"
  );
  const [desktopHeaderVisible, setDesktopHeaderVisible] = useState(
    state === "expanded"
  );
  const profileName =
    profile?.full_name ?? profile?.username ?? profile?.email ?? "Account";

  useEffect(() => {
    if (state === "collapsed") {
      setDesktopBorderReady(false);
      return;
    }
    const timer = window.setTimeout(() => setDesktopBorderReady(true), 150);
    return () => window.clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    if (state === "expanded") {
      setDesktopHeaderVisible(true);
      return;
    }
    const timer = window.setTimeout(() => setDesktopHeaderVisible(false), 300);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <Sidebar
      collapsible="icon"
      className={cn(
        "select-none",
        desktop &&
          (desktopHeaderVisible
            ? "md:pt-12"
            : "md:top-12 md:bottom-auto md:h-[calc(100svh-3rem)]")
      )}
    >
      {desktop && desktopHeaderVisible ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 hidden h-12 border-b bg-sidebar md:block",
            !desktopBorderReady &&
              "after:pointer-events-none after:absolute after:inset-y-0 after:-right-px after:w-px after:bg-sidebar after:content-['']"
          )}
        >
          <WindowDragRegion />
        </div>
      ) : !desktop ? (
        <SidebarHeader className="h-14 justify-center overflow-hidden border-b px-3 py-0 transition-[padding] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none group-data-[collapsible=icon]:px-2">
          <div
            className={cn(
              "flex h-7 items-center",
              state === "expanded" ? "gap-2.5" : "w-7"
            )}
          >
            <svg
              viewBox="0 0 32 32"
              fill="none"
              aria-hidden="true"
              className="size-7 shrink-0 text-brand"
            >
              <circle
                cx="16"
                cy="16"
                r="12"
                stroke="currentColor"
                strokeWidth="2.8"
                strokeLinecap="round"
                strokeDasharray="0.1 6.18"
              />
              <circle cx="16" cy="16" r="4" fill="currentColor" />
            </svg>
            {state === "expanded" ? (
              <span className="text-lg font-semibold tracking-tight">
                Orchestrat
              </span>
            ) : (
              <></>
            )}
          </div>
        </SidebarHeader>
      ) : (
        <></>
      )}
      <SidebarContent className="gap-2 px-3 py-2 group-data-[collapsible=icon]:px-2">
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
                          {route === "messages" && messageCounts?.unread ? (
                            <span
                              className="ml-auto flex items-center gap-1.5 text-[10px] font-medium"
                              aria-label={`${messageCounts.unread} unread messages${messageCounts.mentions ? `, ${messageCounts.mentions} mentions` : ""}`}
                            >
                              <span className="rounded-full bg-primary px-1.5 leading-5 text-primary-foreground">
                                {messageCounts.unread}
                              </span>
                              {messageCounts.mentions ? (
                                <span className="text-brand">
                                  @{messageCounts.mentions}
                                </span>
                              ) : null}
                            </span>
                          ) : null}
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

      <SidebarMenu className="shrink-0 p-3 group-data-[collapsible=icon]:p-2">
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
      <SidebarFooter className="border-t p-3 group-data-[collapsible=icon]:p-2">
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
