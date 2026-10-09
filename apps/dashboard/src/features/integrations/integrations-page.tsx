import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ExternalLink,
  GitBranch,
  RefreshCw,
  TriangleAlert
} from "lucide-react";
import type {
  CreateOrganizationIntegrationRequest,
  IntegrationProvider,
  Organization,
  OrganizationIntegration,
  RepositorySelection
} from "@orchestrat/protocol";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/features/attention/attention-copy";
import {
  integrationKeys,
  organizationIntegrationsQueryOptions,
  organizationRepositoriesQueryOptions
} from "@/features/hierarchy/query-options";
import { repositoryProvidersQueryOptions } from "@/features/repository/query-options";
import { goTo } from "@/features/repository/redirect";
import {
  REPOSITORY_ATTEMPT_KEY,
  callbackErrorMessage,
  providerLabels
} from "@/features/repository/repository-copy";
import type { ApiClient } from "@/lib/api/client";
import { usePlatform } from "@/platform/provider";
import {
  integrationErrorMessage,
  integrationProviders,
  invalidateIntegrations,
  readOrganizationAttemptProvider,
  selectionLabel,
  statusLabel,
  writeOrganizationAttempt
} from "./integration-copy";
import {
  GithubInstallationDialog,
  GitlabAccessDialog,
  type GitlabCandidate
} from "./integration-dialogs";

const connectLabels: Record<IntegrationProvider, string> = {
  github: "Connect GitHub",
  gitlab: "Connect GitLab"
};

const providerBlurbs: Record<IntegrationProvider, string> = {
  github:
    "Install the Orchestrat app on a GitHub account to import its repositories.",
  gitlab: "Connect a GitLab.com account to import projects you maintain."
};

export function IntegrationsPage({
  api,
  organization,
  authorizationId,
  callbackError
}: {
  api: ApiClient;
  organization: Organization;
  authorizationId?: string;
  callbackError?: string;
}) {
  if (organization.role === "member")
    return (
      <section className="dashboard-page max-w-4xl" aria-label="Integrations">
        <p className="text-sm text-muted-foreground">
          Only owners and admins of {organization.name} can connect GitHub or
          GitLab. Ask one of them to connect an account or import a repository.
        </p>
      </section>
    );
  return (
    <ManageIntegrations
      api={api}
      organization={organization}
      authorizationId={authorizationId}
      callbackError={callbackError}
    />
  );
}

function ManageIntegrations({
  api,
  organization,
  authorizationId,
  callbackError
}: {
  api: ApiClient;
  organization: Organization;
  authorizationId?: string;
  callbackError?: string;
}) {
  const organizationId = organization.id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const platform = usePlatform();
  const now = useMemo(() => Date.now(), []);
  const integrations = useQuery(
    organizationIntegrationsQueryOptions(api, organizationId)
  );
  const providers = useQuery(repositoryProvidersQueryOptions(api));
  const [browserNotice, setBrowserNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<OrganizationIntegration | null>(null);
  const [removing, setRemoving] = useState<OrganizationIntegration | null>(
    null
  );

  const clearSearch = () =>
    void navigate({
      to: "/organizations/$organizationId/integrations",
      params: { organizationId },
      search: {
        repository_authorization: undefined,
        repository_error: undefined
      },
      replace: true
    });

  const openExternally = async (url: string, provider: IntegrationProvider) => {
    if (platform.kind === "desktop") {
      await platform.openExternal(new URL(url));
      setBrowserNotice(
        `Finish in your browser. ${providerLabels[provider]} accounts you connect there show up here.`
      );
    } else goTo(url);
  };

  const authorize = useMutation({
    mutationFn: (provider: IntegrationProvider) =>
      api.authorizeOrganizationIntegration(organizationId, {
        provider,
        return_path: `/organizations/${organizationId}/integrations`
      }),
    onSuccess: async (authorization, provider) => {
      // Written before leaving: GitHub's Setup URL comes back without our
      // state, and Try again needs the provider.
      writeOrganizationAttempt({
        authorization_id: authorization.authorization_id,
        organization_id: organizationId,
        provider
      });
      await openExternally(authorization.authorize_url, provider);
    }
  });

  const options = useQuery({
    queryKey: [
      ...integrationKeys.all(organizationId),
      "authorization",
      authorizationId ?? ""
    ],
    queryFn: () =>
      api.getIntegrationAuthorizationOptions(organizationId, authorizationId!),
    enabled: Boolean(authorizationId) && !callbackError,
    retry: false,
    staleTime: Infinity
  });

  const create = useMutation({
    mutationFn: (input: CreateOrganizationIntegrationRequest) =>
      api.createOrganizationIntegration(organizationId, input),
    onSuccess: async () => {
      window.sessionStorage.removeItem(REPOSITORY_ATTEMPT_KEY);
      await invalidateIntegrations(queryClient, organizationId);
      clearSearch();
    }
  });

  const update = useMutation({
    mutationFn: ({
      integration,
      selection,
      ids
    }: {
      integration: OrganizationIntegration;
      selection: RepositorySelection;
      ids: string[];
    }) =>
      api.updateOrganizationIntegration(organizationId, integration.id, {
        repository_selection: selection,
        selected_repository_ids: ids
      }),
    onSuccess: async () => {
      await invalidateIntegrations(queryClient, organizationId);
      setEditing(null);
    }
  });

  const remove = useMutation({
    mutationFn: (integration: OrganizationIntegration) =>
      api.deleteOrganizationIntegration(organizationId, integration.id),
    onSuccess: async () => {
      await invalidateIntegrations(queryClient, organizationId);
      setRemoving(null);
    }
  });

  const allRepositories = useQuery({
    ...organizationRepositoriesQueryOptions(api, organizationId, "all"),
    enabled: editing !== null
  });
  const editCandidates = useMemo<GitlabCandidate[]>(() => {
    if (!editing) return [];
    const known = (allRepositories.data?.repositories ?? [])
      .filter((repository) => repository.integration_id === editing.id)
      .map((repository) => ({
        id: repository.provider_repository_id,
        full_name: repository.full_name
      }));
    const knownIds = new Set(known.map(({ id }) => id));
    const missing = editing.selected_repository_ids
      .filter((id) => !knownIds.has(id))
      .map((id) => ({ id, full_name: id }));
    return [...known, ...missing].sort((a, b) =>
      a.full_name.localeCompare(b.full_name)
    );
  }, [allRepositories.data, editing]);

  const retryProvider = callbackError
    ? readOrganizationAttemptProvider(organizationId)
    : null;
  // Until the options load, the attempt says which dialog is coming.
  const returnedProvider =
    options.data?.provider ??
    readOrganizationAttemptProvider(organizationId) ??
    "github";
  const dialogOpen = Boolean(authorizationId) && !callbackError;
  const optionsError = options.isError
    ? integrationErrorMessage(
        options.error,
        "We couldn’t load the accounts from the provider. Start again."
      )
    : null;
  const createError = create.isError
    ? integrationErrorMessage(
        create.error,
        "We couldn’t connect this account. Try again."
      )
    : null;

  const providerStatus = (provider: IntegrationProvider) =>
    providers.data?.providers.find((item) => item.provider === provider);

  const connectButton = (provider: IntegrationProvider) => {
    const status = providerStatus(provider);
    const unavailable = status && !status.configured;
    const reasonId = `${provider}-unavailable`;
    return (
      <div className="grid justify-items-start gap-1">
        <Button
          type="button"
          variant="outline"
          disabled={Boolean(unavailable) || authorize.isPending}
          aria-describedby={unavailable ? reasonId : undefined}
          onClick={() => {
            authorize.reset();
            setBrowserNotice(null);
            authorize.mutate(provider);
          }}
        >
          <GitBranch data-icon="inline-start" />
          {authorize.isPending && authorize.variables === provider
            ? "Starting…"
            : connectLabels[provider]}
        </Button>
        {unavailable ? (
          <p id={reasonId} className="text-xs text-muted-foreground">
            {status.unavailable_reason ?? "Not set up on this server."}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <section
      className="dashboard-page max-w-4xl"
      aria-label={`${organization.name} integrations`}
    >
      <p className="text-sm text-muted-foreground">
        Connect GitHub or GitLab once for {organization.name}. Owners and admins
        can then import any repository these accounts reach as a project.
      </p>

      {callbackError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {callbackErrorMessage(callbackError)}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={authorize.isPending}
              onClick={() => {
                if (retryProvider) authorize.mutate(retryProvider);
                else clearSearch();
              }}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {authorize.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {integrationErrorMessage(
            authorize.error,
            "We couldn’t start connecting. Try again."
          )}
        </p>
      ) : null}
      {browserNotice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {browserNotice}
        </p>
      ) : null}

      {integrations.isPending ? (
        <div aria-label="Loading integrations" className="grid gap-8">
          {integrationProviders.map((provider) => (
            <div key={provider} className="grid gap-3">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-20 rounded-xl" />
            </div>
          ))}
        </div>
      ) : integrations.isError ? (
        <div role="alert" className="flex items-center gap-3 text-sm">
          We couldn’t load the integrations.
          <Button
            variant="outline"
            size="sm"
            onClick={() => void integrations.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (
        <div className="grid gap-8">
          {integrationProviders.map((provider) => {
            const items = integrations.data.integrations.filter(
              (integration) => integration.provider === provider
            );
            const headingId = `${provider}-integrations`;
            return (
              <section
                key={provider}
                aria-labelledby={headingId}
                className="grid gap-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 id={headingId} className="text-base font-medium">
                      {providerLabels[provider]}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {providerBlurbs[provider]}
                    </p>
                  </div>
                  {items.length > 0 ? connectButton(provider) : null}
                </div>
                {items.length === 0 ? (
                  <Empty className="border py-8">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <GitBranch />
                      </EmptyMedia>
                      <EmptyTitle>
                        No {providerLabels[provider]} accounts connected
                      </EmptyTitle>
                      <EmptyDescription>
                        {provider === "github"
                          ? "Connect GitHub to import its repositories as projects."
                          : "Connect GitLab to import its projects as Orchestrat projects."}
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>{connectButton(provider)}</EmptyContent>
                  </Empty>
                ) : (
                  <ul className="divide-y rounded-xl ring-1 ring-border">
                    {items.map((integration) => (
                      <IntegrationRow
                        key={integration.id}
                        api={api}
                        organizationId={organizationId}
                        integration={integration}
                        now={now}
                        onEdit={() => {
                          update.reset();
                          setEditing(integration);
                        }}
                        onRemove={() => {
                          remove.reset();
                          setRemoving(integration);
                        }}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      {returnedProvider === "gitlab" ? (
        <GitlabAccessDialog
          key={`create-${authorizationId ?? ""}`}
          open={dialogOpen}
          onOpenChange={(open) => {
            if (!open && !create.isPending) clearSearch();
          }}
          description="Choose which GitLab projects this organization can import."
          pending={options.isPending}
          loadError={optionsError}
          onRetry={() => void options.refetch()}
          candidates={(options.data?.repositories ?? [])
            .filter((repository) => repository.eligible)
            .map((repository) => ({
              id: repository.provider_repository_id,
              full_name: repository.full_name
            }))}
          submitLabel="Connect GitLab"
          submittingLabel="Connecting…"
          submitting={create.isPending}
          submitError={createError}
          onSubmit={(selection, ids) =>
            create.mutate({
              provider: "gitlab",
              authorization_id: authorizationId!,
              repository_selection: selection,
              selected_repository_ids: ids
            })
          }
        />
      ) : (
        <GithubInstallationDialog
          open={dialogOpen}
          onOpenChange={(open) => {
            if (!open && !create.isPending) clearSearch();
          }}
          pending={options.isPending}
          loadError={optionsError}
          onRetry={() => void options.refetch()}
          installations={options.data?.installations ?? []}
          installUrl={options.data?.install_url ?? null}
          connectingId={
            create.isPending && create.variables.provider === "github"
              ? create.variables.installation_id
              : null
          }
          connectError={createError}
          onConnect={(installationId) =>
            create.mutate({
              provider: "github",
              authorization_id: authorizationId!,
              installation_id: installationId
            })
          }
          onInstall={() => {
            writeOrganizationAttempt({
              authorization_id: authorizationId!,
              organization_id: organizationId,
              provider: "github"
            });
            void openExternally(options.data!.install_url!, "github");
          }}
        />
      )}

      {editing ? (
        <GitlabAccessDialog
          key={`edit-${editing.id}`}
          open
          onOpenChange={(open) => {
            if (!open && !update.isPending) setEditing(null);
          }}
          description={`Choose which projects ${editing.account_name} gives this organization. The list shows projects found at the last sync.`}
          pending={allRepositories.isPending}
          loadError={
            allRepositories.isError
              ? "We couldn’t load this account’s projects."
              : null
          }
          onRetry={() => void allRepositories.refetch()}
          candidates={editCandidates}
          initialSelection={editing.repository_selection}
          initialSelectedIds={editing.selected_repository_ids}
          submitLabel="Save access"
          submittingLabel="Saving…"
          submitting={update.isPending}
          submitError={
            update.isError
              ? integrationErrorMessage(
                  update.error,
                  "We couldn’t save the access. Try again."
                )
              : null
          }
          onSubmit={(selection, ids) =>
            update.mutate({ integration: editing, selection, ids })
          }
        />
      ) : null}

      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removing?.account_name}?</DialogTitle>
            <DialogDescription>
              {removing?.provider === "github"
                ? "Orchestrat stops importing from this GitHub account. The app stays installed on GitHub until you uninstall it there."
                : "Orchestrat stops importing from this GitLab account."}
            </DialogDescription>
          </DialogHeader>
          {remove.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {integrationErrorMessage(
                remove.error,
                "We couldn’t remove this account. Try again."
              )}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => setRemoving(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing)}
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function IntegrationRow({
  api,
  organizationId,
  integration,
  now,
  onEdit,
  onRemove
}: {
  api: ApiClient;
  organizationId: string;
  integration: OrganizationIntegration;
  now: number;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const queryClient = useQueryClient();
  const platform = usePlatform();
  const refresh = useMutation({
    mutationFn: () =>
      api.refreshOrganizationIntegration(organizationId, integration.id),
    onSuccess: () => invalidateIntegrations(queryClient, organizationId)
  });
  const status = statusLabel(integration);
  const name = integration.account_name;
  return (
    <li className="flex flex-wrap items-start gap-3 p-4">
      <div className="grid min-w-0 flex-1 gap-1">
        <span className="truncate font-medium">
          {name}
          {integration.account_type ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              · {integration.account_type}
            </span>
          ) : null}
        </span>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{selectionLabel(integration)}</span>
          <span>
            {integration.repository_count === 1
              ? "1 repository"
              : `${integration.repository_count} repositories`}
          </span>
          <span>
            {integration.last_synced_at
              ? `Synced ${relativeTime(integration.last_synced_at, now)}`
              : "Not synced yet"}
          </span>
        </p>
        {status ? (
          <p className="flex items-start gap-1.5 text-sm">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-destructive"
              aria-hidden
            />
            <span>
              <span className="font-medium">{status}.</span>
              {integration.status_reason ? (
                <span className="text-muted-foreground">
                  {" "}
                  {integration.status_reason}
                </span>
              ) : null}
            </span>
          </p>
        ) : null}
        {refresh.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {integrationErrorMessage(
              refresh.error,
              "We couldn’t refresh this account. Try again."
            )}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {integration.provider === "github" && integration.manage_url ? (
          <Button asChild variant="outline" size="sm">
            <a
              href={integration.manage_url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Manage on GitHub (${name})`}
              onClick={(event) => {
                if (platform.kind !== "desktop") return;
                event.preventDefault();
                void platform.openExternal(new URL(integration.manage_url!));
              }}
            >
              Manage on GitHub
              <ExternalLink data-icon="inline-end" aria-hidden />
            </a>
          </Button>
        ) : null}
        {integration.provider === "gitlab" ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Edit access for ${name}`}
            onClick={onEdit}
          >
            Edit access
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Refresh ${name}`}
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw data-icon="inline-start" aria-hidden />
          {refresh.isPending ? "Refreshing…" : "Refresh"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}
