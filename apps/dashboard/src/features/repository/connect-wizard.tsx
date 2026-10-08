import { hierarchyKeys } from "@/features/hierarchy/query-options";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { useBranch } from "@/features/branches/branch-context";
import { branchKeys } from "@/features/branches/query-options";
import {
  documentsQueryOptions,
  tasksQueryOptions
} from "@/features/coordination/query-options";
import { chatsQueryOptions } from "@/features/messaging/query-options";
import type { ApiClient } from "@/lib/api/client";
import { usePlatform } from "@/platform/provider";
import {
  ConnectWizardMapStep,
  ConnectWizardPickStep,
  type Mapping
} from "./connect-wizard-body";
import { goTo } from "./redirect";
import { REPOSITORY_ATTEMPT_KEY, mappingCase } from "./repository-copy";
import {
  repositoryCandidatesQueryOptions,
  repositoryKeys
} from "./query-options";

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
        }),
        queryClient.invalidateQueries({
          queryKey: hierarchyKeys.all,
          refetchType: "none"
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
          <ConnectWizardPickStep
            search={search}
            onSearchChange={setSearch}
            repositoryId={repositoryId}
            onRepositoryIdChange={setRepositoryId}
            repositories={repositories}
            shown={shown}
            candidatesPending={candidates.isPending}
            candidatesError={candidates.isError ? candidates.error : null}
            installUrl={installUrl}
            onInstall={install}
          />
        ) : plan ? (
          <ConnectWizardMapStep
            plan={plan}
            chosenName={chosen?.full_name}
            mapping={mapping}
            onMappingChange={setMapping}
            createExisting={createExisting}
            onCreateExistingChange={setCreateExisting}
            existingEmpty={existingEmpty}
            connectError={connect.isError ? connect.error : null}
          />
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
