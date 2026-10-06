import type { Branch } from "@orchestrat/protocol";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "@/components/ui/command";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { CheckIcon } from "lucide-react";

// Every branch, archived ones in their own group (docs/project-branches.md
// §11.2). The branch menu itself lists active branches only.
export function AllBranchesDialog({
  open,
  onOpenChange,
  branches,
  currentBranchId,
  unreadBranchIds,
  onSelect
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branches: Branch[];
  currentBranchId: string;
  unreadBranchIds: ReadonlySet<string>;
  onSelect: (branchId: string) => void;
}) {
  const active = branches.filter((branch) => !branch.archived_at);
  const archived = branches.filter((branch) => branch.archived_at);
  const item = (branch: Branch) => (
    <CommandItem
      key={branch.id}
      value={`${branch.name} ${branch.id}`}
      keywords={[branch.name]}
      onSelect={() => {
        onOpenChange(false);
        onSelect(branch.id);
      }}
      className={branch.archived_at ? "text-muted-foreground" : undefined}
    >
      <span className="min-w-0 flex-1 truncate">{branch.name}</span>
      {unreadBranchIds.has(branch.id) ? (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-primary"
          />
          Unread
        </span>
      ) : null}
      {branch.is_default ? (
        <span className="text-xs text-muted-foreground">Default</span>
      ) : null}
      {branch.archived_at ? <span className="text-xs">Archived</span> : null}
      {branch.id === currentBranchId ? (
        <>
          <CheckIcon aria-hidden="true" className="size-4" />
          <span className="sr-only">Current branch</span>
        </>
      ) : null}
    </CommandItem>
  );
  return (
    <CommandDialog
      title=""
      description=""
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogHeader className="sr-only">
        <DialogTitle>All branches</DialogTitle>
        <DialogDescription>Search this project’s branches.</DialogDescription>
      </DialogHeader>
      <Command>
        <CommandInput placeholder="Search branches…" />
        <CommandList>
          <CommandEmpty>No branches found.</CommandEmpty>
          {active.length ? (
            <CommandGroup heading="Active">{active.map(item)}</CommandGroup>
          ) : null}
          {archived.length ? (
            <CommandGroup heading="Archived">{archived.map(item)}</CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
