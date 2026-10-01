import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Plus, Search, Settings } from "lucide-react";
import type { Branch } from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import type { ApiClient } from "@/lib/api/client";
import { inboxAllBranchesQueryOptions } from "@/features/messaging/query-options";
import { useBranch } from "./branch-context";

/** How many active branches the menu lists before "All branches…". */
export const BRANCH_MENU_LIMIT = 12;

/** Branches with unread messages, from the all-branches inbox (§11.2). */
export function useUnreadBranchIds(api: ApiClient, projectId: string) {
  const inbox = useQuery(inboxAllBranchesQueryOptions(api, projectId));
  return new Set(
    (inbox.data?.unread_chats ?? [])
      .filter((chat) => chat.unread_count > 0 && chat.branch_id)
      .map((chat) => chat.branch_id as string)
  );
}

/** The default first, then the most recently updated, as the API orders
 * them; the current branch stays listed even when archived or further down. */
export function menuBranches(branches: Branch[], current: Branch) {
  const listed = branches
    .filter((branch) => !branch.archived_at)
    .slice(0, BRANCH_MENU_LIMIT);
  return listed.some((branch) => branch.id === current.id)
    ? listed
    : [...listed, current];
}

// The third breadcrumb: Organization › Project › Branch › Page. It copies the
// project selector's menu (docs/project-branches.md §11.2).
export function BranchSelector({ api }: { api: ApiClient }) {
  const navigate = useNavigate();
  const {
    projectId,
    branches,
    branch,
    projectArchived,
    selectBranch,
    openAllBranches,
    openCreateBranch
  } = useBranch();
  const unread = useUnreadBranchIds(api, projectId);
  const listed = menuBranches(branches, branch);
  const activeCount = branches.filter((item) => !item.archived_at).length;
  const showAll =
    activeCount > BRANCH_MENU_LIMIT ||
    branches.some((item) => item.archived_at);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={"Branch: " + branch.name}
          className="w-max max-w-full min-w-0 px-1.5 font-normal text-muted-foreground hover:text-primary-text data-[state=open]:text-primary-text"
        >
          <span className="truncate">{branch.name}</span>
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align="start">
        <DropdownMenuLabel>Branches</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={branch.id} onValueChange={selectBranch}>
          {listed.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id}>
              <span className="truncate">{item.name}</span>
              {unread.has(item.id) ? (
                <>
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full bg-primary"
                  />
                  <span className="sr-only">Unread messages</span>
                </>
              ) : null}
              {item.is_default ? (
                <span className="ml-auto text-xs text-muted-foreground">
                  Default
                </span>
              ) : item.archived_at ? (
                <span className="ml-auto text-xs text-muted-foreground">
                  Archived
                </span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {showAll ? (
          <DropdownMenuItem onSelect={openAllBranches}>
            <Search />
            All branches…
          </DropdownMenuItem>
        ) : null}
        {!projectArchived ? (
          <DropdownMenuItem onSelect={openCreateBranch}>
            <Plus />
            New branch
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() =>
            void navigate({
              to: "/projects/$projectId/settings",
              params: { projectId },
              hash: "branches"
            })
          }
        >
          <Settings />
          Branch settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
