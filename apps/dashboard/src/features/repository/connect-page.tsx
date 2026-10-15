import { hierarchyKeys } from "@/features/hierarchy/query-options";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { RepositoryProvider } from "@orchestrat/protocol";
import { PageHeader } from "@/components/dashboard/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBranch } from "@/features/branches/branch-context";
import { branchKeys } from "@/features/branches/query-options";
import {
  documentsQueryOptions,
  tasksQueryOptions
} from "@/features/coordination/query-options";
import { chatsQueryOptions } from "@/features/messaging/query-options";
import { DashboardApiError, type ApiClient } from "@/lib/api/client";
import { usePlatform } from "@/platform/provider";
import {
  ConnectWizardMapStep,
  ConnectWizardPickStep,
  type Mapping
} from "./connect-wizard-body";
import { goTo } from "./redirect";
import {
  repositoryCandidatesQueryOptions,
  repositoryKeys,
  repositoryQueryOptions
} from "./query-options";
import {
  REPOSITORY_ATTEMPT_KEY,
  callbackErrorMessage,
  mappingCase,
  providerLabels
} from "./repository-copy";

function authorizeErrorMessage(error: unknown) {
  if (!(error instanceof DashboardApiError))
    return "We couldn’t start connecting. Try again.";
  if (error.kind === "REPOSITORY_NOT_CONFIGURED")
    return "This provider isn’t set up on this server.";
  if (error.kind === "PERMISSION_DENIED")
    return "Only project owners and admins can change the repository.";
  if (error.kind === "NETWORK_ERROR")
    return "We couldn’t reach the Dashboard API. Check your connection and try again.";
  return error.message;
}

function readAttemptProvider(projectId: string): RepositoryProvider | null {
  try {
    const raw = window.sessionStorage.getItem(REPOSITORY_ATTEMPT_KEY);
    if (!raw) return null;
    const attempt = JSON.parse(raw) as {
      project_id?: string;
      provider?: RepositoryProvider;
    };
    if (attempt.project_id !== projectId) return null;
    return attempt.provider ?? null;
  } catch {
    return null;
  }
}

export function ConnectPage({
  api,
  projectId,
  authorizationId,
  callbackError
}: {
  api: ApiClient;
  projectId: string;
  authorizationId?: string;
  callbackError?: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const platform = usePlatform();
  const { branches, canManage, projectArchived } = useBranch();
  const canAct = canManage && !projectArchived;
  const repository = useQuery(repositoryQueryOptions(api, projectId));
  const connection = repository.data?.repository ?? null;
  const providers = repository.data?.providers ?? [];
  const goOverview = () =>
    void navigate({
      to: "/projects/$projectId/overview",
      params: { projectId }
    });

  useEffect(() => {
    if (repository.isSuccess && connection) {
      void navigate({
        to: "/projects/$projectId/overview",
        params: { projectId }
      });
    }
  }, [repository.isSuccess, connection, navigate, projectId]);

  const start = useMutation({
    mutationFn: (provider: RepositoryProvider) =>
      api.authorizeRepository(projectId, {
        provider,
        return_path: `/projects/${projectId}/connect`
      }),
    onSuccess: async (authorization, provider) => {
      window.sessionStorage.setItem(
        REPOSITORY_ATTEMPT_KEY,
        JSON.stringify({
          authorization_id: authorization.authorization_id,
          project_id: projectId,
          provider
        })
      );
      if (platform.kind === "desktop") {
        await platform.openExternal(new URL(authorization.authorize_url));
      } else goTo(authorization.authorize_url);
    }
  });

  const retryProvider = readAttemptProvider(projectId);
  const tryAgain = () => {
    start.reset();
    if (retryProvider) start.mutate(retryProvider);
  };

  if (repository.isPending) {
    return (
      <section className="dashboard-page">
        <PageHeader
          title="Connect a repository"
          description="Loading the repository connection…"
        />
        <div
          role="status"
          aria-label="Loading the repository connection"
          className="mx-auto grid w-full max-w-lg gap-3"
        >
          <Skeleton className="h-9 rounded-lg" />
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-10 w-40 rounded-lg" />
        </div>
      </section>
    );
  }

  if (repository.isError) {
    return (
      <section className="dashboard-page">
        <PageHeader
          title="Connect a repository"
          description="We couldn’t load the repository connection."
        />
        <Alert variant="destructive">
          <AlertDescription>
            {authorizeErrorMessage(repository.error)}
          </AlertDescription>
        </Alert>
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() => void repository.refetch()}
        >
          Retry
        </Button>
      </section>
    );
  }

  if (connection) {
    return (
      <section className="dashboard-page">
        <PageHeader
          title="Connect a repository"
          description="This project already has a repository. Taking you to the overview…"
        />
      </section>
    );
  }

  if (!canAct) {
    return (
      <section className="dashboard-page">
        <PageHeader
          title="Connect a repository"
          description="Only project owners and admins can connect a repository."
        />
        <p className="text-sm text-muted-foreground">
          Ask an owner or admin to finish connecting, or skip for now.
        </p>
        <Button type="button" variant="outline" onClick={goOverview}>
          Skip for now
        </Button>
      </section>
    );
  }

  const notConnected = Boolean(callbackError) || !authorizationId;
  if (notConnected) {
    return (
      <section className="dashboard-page">
        <PageHeader
          title="Not connected"
          description={
            callbackError
              ? callbackErrorMessage(callbackError)
              : "No repository authorization is ready for this project yet."
          }
        />
        {start.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {authorizeErrorMessage(start.error)}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {retryProvider ? (
            <Button type="button" disabled={start.isPending} onClick={tryAgain}>
              {start.isPending ? "Starting…" : "Try again"}
            </Button>
          ) : (
            providers.map((provider) => (
              <Button
                key={provider.provider}
                type="button"
                variant="outline"
                disabled={!provider.configured || start.isPending}
                onClick={() => start.mutate(provider.provider)}
              >
                Connect {providerLabels[provider.provider]}
              </Button>
            ))
          )}
          <Button type="button" variant="outline" onClick={goOverview}>
            Skip for now
          </Button>
        </div>
      </section>
    );
  }

  return (
    <ConnectFlow
      api={api}
      projectId={projectId}
      authorizationId={authorizationId!}
      branches={branches}
      onSkip={goOverview}
      onConnected={async () => {
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
        goOverview();
      }}
    />
  );
}

function ConnectFlow({
  api,
  projectId,
  authorizationId,
  branches,
  onSkip,
  onConnected
}: {
  api: ApiClient;
  projectId: string;
  authorizationId: string;
  branches: ReturnType<typeof useBranch>["branches"];
  onSkip: () => void;
  onConnected: () => Promise<void>;
}) {
  const platform = usePlatform();
  const [step, setStep] = useState<"pick" | "map">("pick");
  const [search, setSearch] = useState("");
  const [repositoryId, setRepositoryId] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Mapping | "">("");
  const [createExisting, setCreateExisting] = useState(false);
  const candidates = useQuery(
    repositoryCandidatesQueryOptions(api, projectId, authorizationId)
  );
  const repositories = candidates.data?.repositories ?? [];
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
      await onConnected();
    }
  });
  const term = search.trim().toLowerCase();
  const shown = repositories.filter((repository) =>
    repository.full_name.toLowerCase().includes(term)
  );

  return (
    <section className="dashboard-page">
      <PageHeader
        title={step === "pick" ? "Choose a repository" : "Default branch"}
        description={
          step === "pick"
            ? "Branches in this project will follow the repository you choose."
            : `How ${chosen?.full_name ?? "the repository"}’s default branch links to this project.`
        }
        actions={
          <Button type="button" variant="outline" onClick={onSkip}>
            Skip for now
          </Button>
        }
      />
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
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
            createExistingId="connect-page-create-existing"
          />
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          {step === "pick" ? (
            <Button
              type="button"
              disabled={!chosen?.eligible}
              onClick={() => setStep("map")}
            >
              Next
            </Button>
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
        </div>
      </div>
    </section>
  );
}
