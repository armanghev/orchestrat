import { useEffect, useRef } from "react";
import type { AppCommand } from "@/features/command/commands";
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

const groups: AppCommand["group"][] = [
  "Projects",
  "Navigate",
  "Appearance",
  "Application"
];

export function CommandMenu({
  open,
  onOpenChange,
  commands,
  triggerRef
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: AppCommand[];
  triggerRef?: React.RefObject<HTMLElement | null>;
}) {
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) triggerRef?.current?.focus();
    wasOpen.current = open;
  }, [open, triggerRef]);
  return (
    <CommandDialog
      title=""
      description=""
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogHeader className="sr-only">
        <DialogTitle>Command Palette</DialogTitle>
        <DialogDescription>Search for a command to run...</DialogDescription>
      </DialogHeader>
      <Command>
        <CommandInput placeholder="Search commands…" />
        <CommandList>
          <CommandEmpty>No commands found.</CommandEmpty>
          {groups.map((group) => {
            const members = commands.filter(
              (command) => command.group === group
            );
            return members.length ? (
              <CommandGroup key={group} heading={group}>
                {members.map((command) => (
                  <CommandItem
                    key={command.id}
                    value={`${command.label} ${command.keywords.join(" ")}`}
                    onSelect={() => {
                      onOpenChange(false);
                      try {
                        void Promise.resolve(command.run()).catch(
                          () => undefined
                        );
                      } catch {
                        /* A synchronous command failure is contained after the menu closes. */
                      }
                    }}
                  >
                    {command.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null;
          })}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
