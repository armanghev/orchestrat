import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useBranch } from "@/features/branches/branch-context";
import { branchKeys } from "@/features/branches/query-options";
import {
  documentsQueryOptions,
  tasksQueryOptions
} from "@/features/coordination/query-options";
import { chatsQueryOptions } from "@/features/messaging/query-options";
import { DashboardApiError, type ApiClient } from "@/lib/api/client";
import { cn } from "@/lib/cn";
import { usePlatform } from "@/platform/provider";
import { goTo } from "./redirect";
import { REPOSITORY_ATTEMPT_KEY, mappingCase } from "./repository-copy";
import {
  repositoryCandidatesQueryOptions,
  repositoryKeys
} from "./query-options";

type Mapping = "rename_default" | "use_existing";

function connectErrorMessage(error: unknown) {
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

// After the provider redirect (docs/project-branches.md §11.8): pick a
// repository, see how the default branch will be linked, and connect.
export function ConnectWizard({
  api,
  projectId,
  authorizationId,
  onClose
}: {
  api: ApiClient;
  projectId: string;
  authorizationId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const platform = usePlatform();
  const { branches } = useBranch();
  const [step, setStep] = useState<"pick" | "map">("pick");
  const [search, setSearch] = useState("");
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Mapping | "">("");
  const [createExisting, setCreateExisting] = useState(false);
  const candidates = useQuery(
    repositoryCandidatesQueryOptions(api, projectId, authorizationId)
  );
  const repositories = candidates.data?.repositories ?? [];
  // GitHub lists only repositories where the app is installed (§8.3).
  const installUrl = candidates.data?.install_url ?? null;
  const install = (url: string) =>
    platform.kind === "desktop"
      ? void platform.openExternal(new URL(url))
      : goTo(url);
  const chosen = repositories.find(
    (repository) => repository.provider_repository_id === repositoryId
  );
  const plan = chosen
    ? mappingCase(branches, chosen.default_branch)
    : undefined;
  const existing = plan?.kind === "choose" ? plan.existing : undefined;
  // Keeping the default's work is recommended when the other branch is
  // empty; otherwise the person chooses (spec §8.7).
  const existingTasks = useQuery({
    ...tasksQueryOptions(api, projectId, existing?.id),
    enabled: Boolean(existing)
  });
  const existingDocuments = useQuery({
    ...documentsQueryOptions(api, projectId, existing?.id),
    enabled: Boolean(existing)
  });
  const existingChats = useQuery({
    ...chatsQueryOptions(api, projectId, existing?.id),
    enabled: Boolean(existing)
  });
  const existingEmpty =
    existingTasks.data?.tasks.length === 0 &&
    existingDocuments.data?.documents.length === 0 &&
    existingChats.data?.chats.length === 0;
  useEffect(() => {
    if (plan?.kind !== "choose") setMapping("rename_default");
    else setMapping(existingEmpty ? "rename_default" : "");
  }, [plan?.kind, existingEmpty]);
  const connect = useMutation({
    mutationFn: () =>
      api.connectRepository(projectId, {
        authorization_id: authorizationId,
        provider_repository_id: repositoryId!,
        default_branch_mapping:
          mapping === "use_existing" && existing
            ? { mode: "use_existing", branch_id: existing.id }
            : { mode: "rename_default" },
        create_existing_branches: createExisting
      }),
    onSuccess: async () => {
      window.sessionStorage.removeItem(REPOSITORY_ATTEMPT_KEY);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: repositoryKeys.project(projectId)
        }),
        queryClient.invalidateQueries({
          queryKey: branchKeys.project(projectId)
        })
      ]);
      onClose();
    }
  });
  const term = search.trim().toLowerCase();
  const shown = repositories.filter((repository) =>
    repository.full_name.toLowerCase().includes(term)
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !connect.isPending) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        showCloseButton={!connect.isPending}
      >
        <DialogHeader>
          <DialogTitle>
            {step === "pick" ? "Choose a repository" : "Default branch"}
          </DialogTitle>
          <DialogDescription>
            {step === "pick"
              ? "Branches in this project will follow the repository you choose."
              : `How ${chosen?.full_name ?? "the repository"}’s default branch links to this project.`}
          </DialogDescription>
        </DialogHeader>
        {step === "pick" ? (
          <div className="flex flex-col gap-3">
            {candidates.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading repositories…
              </p>
            ) : candidates.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {connectErrorMessage(candidates.error)}
              </p>
            ) : repositories.length ? (
              <>
                <Input
                  type="search"
                  aria-label="Search repositories"
                  placeholder="Search repositories"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <RadioGroup
                  aria-label="Repository"
                  value={repositoryId ?? ""}
                  onValueChange={setRepositoryId}
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
                This authorization can’t see any repositories. Grant access to
                one on the provider and start again.
              </p>
            )}
            {installUrl ? (
              <p className="text-sm text-muted-foreground">
                {repositories.length ? "Don’t see your repository? " : ""}
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0"
                  onClick={() => install(installUrl)}
                >
                  Install the GitHub App
                </Button>{" "}
                on the account that owns it, then come back here.
              </p>
            ) : null}
          </div>
        ) : plan ? (
          <div className="flex flex-col gap-4 text-sm">
            {plan.kind === "link" ? (
              <p>
                Your default branch <strong>{plan.name}</strong> will track{" "}
                {chosen?.full_name}’s <strong>{plan.name}</strong>. Nothing is
                renamed.
              </p>
            ) : plan.kind === "rename" ? (
              <p>
                Your default branch <strong>{plan.from}</strong> will be renamed
                to <strong>{plan.to}</strong> and track it. All existing work
                stays.
              </p>
            ) : (
              <>
                <p>
                  This project already has a branch named{" "}
                  <strong>{plan.to}</strong>, the repository’s default. Choose
                  which one becomes the default.
                </p>
                <RadioGroup
                  aria-label="Default branch"
                  value={mapping}
                  onValueChange={(value) => setMapping(value as Mapping)}
                >
                  <label className="flex items-start gap-2">
                    <RadioGroupItem value="rename_default" className="mt-0.5" />
                    <span>
                      Keep <strong>{plan.from}</strong>’s work as{" "}
                      <strong>{plan.to}</strong> and archive the other{" "}
                      <strong>{plan.to}</strong> branch. Its work stays and can
                      still be imported.
                      {existingEmpty ? " Recommended: it’s empty." : ""}
                    </span>
                  </label>
                  <label className="flex items-start gap-2">
                    <RadioGroupItem value="use_existing" className="mt-0.5" />
                    <span>
                      Make the existing <strong>{plan.to}</strong> branch the
                      default and leave <strong>{plan.from}</strong> as an
                      ordinary branch.
                    </span>
                  </label>
                </RadioGroup>
              </>
            )}
            <div className="flex items-start gap-2">
              <Checkbox
                id="repository-create-existing"
                className="mt-0.5"
                checked={createExisting}
                onCheckedChange={(checked) =>
                  setCreateExisting(checked === true)
                }
              />
              <Label
                htmlFor="repository-create-existing"
                className="leading-snug font-normal"
              >
                Also create Orchestrat branches for the repository’s other
                existing branches. Otherwise each one gets a branch the first
                time it’s pushed.
              </Label>
            </div>
            {connect.isError ? (
              <p role="alert" className="text-destructive">
                {connectErrorMessage(connect.error)}
              </p>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          {step === "pick" ? (
            <>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!chosen?.eligible}
                onClick={() => setStep("map")}
              >
                Next
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={connect.isPending}
                onClick={() => {
                  connect.reset();
                  setStep("pick");
                }}
              >
                Back
              </Button>
              <Button
                type="button"
                disabled={!mapping || connect.isPending}
                onClick={() => connect.mutate()}
              >
                {connect.isPending ? "Connecting…" : "Connect"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
