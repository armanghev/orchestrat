import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { branchNameSchema, type Branch } from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DashboardApiError, type ApiClient } from "@/lib/api/client";
import { branchKeys } from "./query-options";

// New branch. Names follow Git's rules so an agent on the same Git branch
// joins it.
export function CreateBranchDialog({
  api,
  projectId,
  open,
  onOpenChange,
  onCreated
}: {
  api: ApiClient;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (branch: Branch) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (value: string) => api.createBranch(projectId, { name: value }),
    onSuccess: async (branch) => {
      await queryClient.invalidateQueries({
        queryKey: branchKeys.project(projectId)
      });
      onOpenChange(false);
      onCreated(branch);
    }
  });
  const { reset } = create;
  useEffect(() => {
    if (open) return;
    setName("");
    setInvalid(null);
    reset();
  }, [open, reset]);
  const failure =
    create.error instanceof DashboardApiError
      ? create.error.kind === "BRANCH_NAME_TAKEN"
        ? `A branch named ${name.trim()} already exists.`
        : create.error.kind === "PROJECT_ARCHIVED"
          ? "This project is archived, so it can't get new branches."
          : create.error.kind === "NETWORK_ERROR"
            ? "We couldn’t reach the Dashboard API. Check your connection and try again."
            : create.error.message
      : create.error
        ? "We couldn’t create the branch. Try again."
        : null;
  const error = invalid ?? failure;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !create.isPending && onOpenChange(next)}
    >
      <DialogContent showCloseButton={!create.isPending}>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = branchNameSchema.safeParse(name.trim());
            if (!parsed.success) {
              setInvalid(
                parsed.error.issues[0]?.message ?? "Enter a valid branch name."
              );
              return;
            }
            setInvalid(null);
            create.mutate(parsed.data);
          }}
        >
          <DialogHeader>
            <DialogTitle>New branch</DialogTitle>
            <DialogDescription>
              A branch keeps its own tasks, documents and messages.
            </DialogDescription>
          </DialogHeader>
          <div className="my-5 space-y-2">
            <Label htmlFor="branch-name">Branch name</Label>
            <Input
              id="branch-name"
              autoComplete="off"
              autoFocus
              spellCheck={false}
              placeholder="feat/checkout"
              disabled={create.isPending}
              value={name}
              aria-invalid={error ? true : undefined}
              aria-describedby="branch-name-help"
              onChange={(event) => {
                setName(event.target.value);
                setInvalid(null);
                if (create.isError) create.reset();
              }}
            />
            <p id="branch-name-help" className="text-sm text-muted-foreground">
              Use the Git branch name. Agents on this Git branch will join it
              automatically.
            </p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={create.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? "Creating…" : "Create branch"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
