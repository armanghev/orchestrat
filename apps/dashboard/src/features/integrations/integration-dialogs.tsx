import { useId, useMemo, useState } from "react";
import { Search } from "lucide-react";
import type {
  GithubInstallationOption,
  RepositorySelection
} from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";

function LoadState({
  pending,
  error,
  onRetry,
  label
}: {
  pending: boolean;
  error: string | null;
  onRetry: () => void;
  label: string;
}) {
  if (pending)
    return (
      <div role="status" aria-label={label} className="grid gap-2">
        <Skeleton className="h-12 rounded-lg" />
        <Skeleton className="h-12 rounded-lg" />
      </div>
    );
  if (error)
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
        {error}
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  return null;
}

/** After GitHub returns: pick which app installation to connect. */
export function GithubInstallationDialog({
  open,
  onOpenChange,
  pending,
  loadError,
  onRetry,
  installations,
  installUrl,
  connectingId,
  connectError,
  onConnect,
  onInstall
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  loadError: string | null;
  onRetry: () => void;
  installations: GithubInstallationOption[];
  installUrl: string | null;
  connectingId: string | null;
  connectError: string | null;
  onConnect: (installationId: string) => void;
  onInstall: () => void;
}) {
  const busy = connectingId !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose a GitHub account</DialogTitle>
          <DialogDescription>
            Connect an account where the Orchestrat app is installed. Its
            repositories become available to import in this organization.
          </DialogDescription>
        </DialogHeader>
        {pending || loadError ? (
          <LoadState
            pending={pending}
            error={loadError}
            onRetry={onRetry}
            label="Loading GitHub accounts"
          />
        ) : installations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The Orchestrat app isn’t installed on any GitHub account you can use
            yet.
          </p>
        ) : (
          <ul
            aria-label="GitHub accounts"
            className="grid divide-y rounded-lg ring-1 ring-border"
          >
            {installations.map((installation) => (
              <li
                key={installation.installation_id}
                className="flex flex-wrap items-center gap-3 p-3"
              >
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate font-medium">
                    {installation.account_name}
                    {installation.account_type ? (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · {installation.account_type}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {installation.repository_selection === "all"
                      ? "All repositories"
                      : "Selected repositories"}
                  </span>
                </span>
                {installation.connected ? (
                  <span className="text-xs text-muted-foreground">
                    Connected
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`Connect ${installation.account_name}`}
                    disabled={busy}
                    onClick={() => onConnect(installation.installation_id)}
                  >
                    {connectingId === installation.installation_id
                      ? "Connecting…"
                      : "Connect"}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {connectError ? (
          <p role="alert" className="text-sm text-destructive">
            {connectError}
          </p>
        ) : null}
        {installUrl ? (
          <div className="grid gap-2 border-t pt-4">
            <p className="text-sm text-muted-foreground">
              GitHub’s install screen is where you choose all repositories or
              only the ones you select.
            </p>
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              disabled={busy}
              onClick={onInstall}
            >
              Install on another account
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export type GitlabCandidate = { id: string; full_name: string };

/** GitLab: every project the person maintains, or only chosen ones. */
export function GitlabAccessDialog({
  open,
  onOpenChange,
  description,
  pending,
  loadError,
  onRetry,
  candidates,
  initialSelection = "all",
  initialSelectedIds = [],
  submitLabel,
  submittingLabel,
  submitting,
  submitError,
  onSubmit
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  description: string;
  pending: boolean;
  loadError: string | null;
  onRetry: () => void;
  candidates: GitlabCandidate[];
  initialSelection?: RepositorySelection;
  initialSelectedIds?: string[];
  submitLabel: string;
  submittingLabel: string;
  submitting: boolean;
  submitError: string | null;
  onSubmit: (selection: RepositorySelection, selectedIds: string[]) => void;
}) {
  const [selection, setSelection] =
    useState<RepositorySelection>(initialSelection);
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(initialSelectedIds)
  );
  const [search, setSearch] = useState("");
  const searchId = useId();
  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    return candidates.filter((candidate) =>
      candidate.full_name.toLowerCase().includes(term)
    );
  }, [candidates, search]);
  const toggle = (id: string, checked: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const invalid = selection === "selected" && chosen.size === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (invalid || submitting) return;
            onSubmit(selection, selection === "selected" ? [...chosen] : []);
          }}
        >
          <DialogHeader>
            <DialogTitle>Choose GitLab access</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <RadioGroup
            aria-label="GitLab access"
            value={selection}
            onValueChange={(value) =>
              setSelection(value as RepositorySelection)
            }
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem value="all" id={`${searchId}-all`} />
              <Label htmlFor={`${searchId}-all`}>
                All projects you maintain
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="selected" id={`${searchId}-selected`} />
              <Label htmlFor={`${searchId}-selected`}>
                Only selected projects
              </Label>
            </div>
          </RadioGroup>
          {selection === "selected" ? (
            pending || loadError ? (
              <LoadState
                pending={pending}
                error={loadError}
                onRetry={onRetry}
                label="Loading GitLab projects"
              />
            ) : (
              <div className="grid gap-2">
                <Label htmlFor={searchId} className="sr-only">
                  Search projects
                </Label>
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    id={searchId}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search projects"
                    className="pl-8"
                    autoComplete="off"
                  />
                </div>
                {candidates.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No GitLab projects you maintain were found.
                  </p>
                ) : shown.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No projects match your search.
                  </p>
                ) : (
                  <ul
                    aria-label="GitLab projects"
                    className="grid max-h-64 divide-y overflow-y-auto rounded-lg ring-1 ring-border"
                  >
                    {shown.map((candidate) => {
                      const id = `${searchId}-repo-${candidate.id}`;
                      return (
                        <li
                          key={candidate.id}
                          className="flex items-center gap-2 px-3 py-2"
                        >
                          <Checkbox
                            id={id}
                            checked={chosen.has(candidate.id)}
                            onCheckedChange={(checked) =>
                              toggle(candidate.id, checked === true)
                            }
                          />
                          <Label
                            htmlFor={id}
                            className="min-w-0 truncate font-normal"
                          >
                            {candidate.full_name}
                          </Label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {chosen.size === 1
                    ? "1 project selected"
                    : `${chosen.size} projects selected`}
                </p>
              </div>
            )
          ) : null}
          {submitError ? (
            <p role="alert" className="text-sm text-destructive">
              {submitError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={invalid || submitting}>
              {submitting ? submittingLabel : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
