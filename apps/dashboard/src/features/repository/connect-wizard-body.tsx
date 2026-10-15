import type { ReactNode } from "react";
import type { RepositoryCandidate } from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardApiError } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import type { MappingCase } from "./repository-copy";

export type Mapping = "rename_default" | "use_existing";

export function connectErrorMessage(error: unknown) {
  if (!(error instanceof DashboardApiError))
    return "We couldn’t connect the repository. Try again.";
  if (error.kind === "REPOSITORY_AUTHORIZATION_INVALID")
    return "This authorization expired or was already used. Start again.";
  if (error.kind === "REPOSITORY_CONNECTION_EXISTS")
    return "A repository is already connected to this project.";
  if (error.kind === "NETWORK_ERROR")
    return "We couldn’t reach the Dashboard API. Check your connection and try again.";
  return error.message;
}

export function ConnectWizardPickStep({
  search,
  onSearchChange,
  repositoryId,
  onRepositoryIdChange,
  repositories,
  shown,
  candidatesPending,
  candidatesError,
  installUrl,
  onInstall
}: {
  search: string;
  onSearchChange: (value: string) => void;
  repositoryId: string | null;
  onRepositoryIdChange: (value: string) => void;
  repositories: RepositoryCandidate[];
  shown: RepositoryCandidate[];
  candidatesPending: boolean;
  candidatesError: unknown;
  installUrl: string | null;
  onInstall: (url: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {candidatesPending ? (
        <div
          role="status"
          aria-label="Loading repositories"
          className="grid gap-2"
        >
          <Skeleton className="h-9 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
          <Skeleton className="h-28 rounded-lg" />
        </div>
      ) : candidatesError ? (
        <p role="alert" className="text-sm text-destructive">
          {connectErrorMessage(candidatesError)}
        </p>
      ) : repositories.length ? (
        <>
          <Input
            type="search"
            aria-label="Search repositories"
            placeholder="Search repositories"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
          <RadioGroup
            aria-label="Repository"
            value={repositoryId ?? ""}
            onValueChange={onRepositoryIdChange}
            className="max-h-72 gap-0 divide-y overflow-y-auto rounded-lg border"
          >
            {shown.map((repository) => (
              <label
                key={repository.provider_repository_id}
                className={cn(
                  "flex items-start gap-3 px-3 py-2.5 text-sm",
                  !repository.eligible && "text-muted-foreground"
                )}
              >
                <RadioGroupItem
                  className="mt-0.5"
                  value={repository.provider_repository_id}
                  disabled={!repository.eligible}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {repository.full_name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {repository.eligible
                      ? repository.default_branch
                        ? `Default branch: ${repository.default_branch}`
                        : "No default branch yet"
                      : repository.ineligible_reason}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </>
      ) : installUrl ? (
        <p className="text-sm text-muted-foreground">
          The GitHub App isn’t installed where you have repositories yet.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          This authorization can’t see any repositories. Grant access to one on
          the provider and start again.
        </p>
      )}
      {installUrl ? (
        <p className="text-sm text-muted-foreground">
          {repositories.length ? "Don’t see your repository? " : ""}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            onClick={() => onInstall(installUrl)}
          >
            Install the GitHub App
          </Button>{" "}
          on the account that owns it, then come back here.
        </p>
      ) : null}
    </div>
  );
}

export function ConnectWizardMapStep({
  plan,
  chosenName,
  mapping,
  onMappingChange,
  createExisting,
  onCreateExistingChange,
  existingEmpty,
  connectError,
  createExistingId = "repository-create-existing"
}: {
  plan: MappingCase;
  chosenName: string | undefined;
  mapping: Mapping | "";
  onMappingChange: (value: Mapping) => void;
  createExisting: boolean;
  onCreateExistingChange: (value: boolean) => void;
  existingEmpty: boolean;
  connectError: unknown;
  createExistingId?: string;
}) {
  let planCopy: ReactNode;
  if (plan.kind === "link") {
    planCopy = (
      <p>
        Your default branch <strong>{plan.name}</strong> will track {chosenName}
        ’s <strong>{plan.name}</strong>. Nothing is renamed.
      </p>
    );
  } else if (plan.kind === "rename") {
    planCopy = (
      <p>
        Your default branch <strong>{plan.from}</strong> will be renamed to{" "}
        <strong>{plan.to}</strong> and track it. All existing work stays.
      </p>
    );
  } else {
    planCopy = (
      <>
        <p>
          This project already has a branch named <strong>{plan.to}</strong>,
          the repository’s default. Choose which one becomes the default.
        </p>
        <RadioGroup
          aria-label="Default branch"
          value={mapping}
          onValueChange={(value) => onMappingChange(value as Mapping)}
        >
          <label className="flex items-start gap-2">
            <RadioGroupItem value="rename_default" className="mt-0.5" />
            <span>
              Keep <strong>{plan.from}</strong>’s work as{" "}
              <strong>{plan.to}</strong> and archive the other{" "}
              <strong>{plan.to}</strong> branch. Its work stays and can still be
              imported.
              {existingEmpty ? " Recommended: it’s empty." : ""}
            </span>
          </label>
          <label className="flex items-start gap-2">
            <RadioGroupItem value="use_existing" className="mt-0.5" />
            <span>
              Make the existing <strong>{plan.to}</strong> branch the default
              and leave <strong>{plan.from}</strong> as an ordinary branch.
            </span>
          </label>
        </RadioGroup>
      </>
    );
  }
  return (
    <div className="flex flex-col gap-4 text-sm">
      {planCopy}
      <div className="flex items-start gap-2">
        <Checkbox
          id={createExistingId}
          className="mt-0.5"
          checked={createExisting}
          onCheckedChange={(checked) =>
            onCreateExistingChange(checked === true)
          }
        />
        <Label htmlFor={createExistingId} className="leading-snug font-normal">
          Also create Orchestrat branches for the repository’s other existing
          branches. Otherwise each one gets a branch the first time it’s pushed.
        </Label>
      </div>
      {connectError ? (
        <p role="alert" className="text-destructive">
          {connectErrorMessage(connectError)}
        </p>
      ) : null}
    </div>
  );
}
