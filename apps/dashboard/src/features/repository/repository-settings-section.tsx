import { hierarchyKeys } from "@/features/hierarchy/query-options";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RepositoryConnection,
  RepositoryProvider
} from "@orchestrat/protocol";
import { StatusBadge } from "@/components/dashboard/page";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
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
import { DashboardApiError, type ApiClient } from "@/lib/api/client";
import { usePlatform } from "@/platform/provider";
import { ConnectWizard } from "./connect-wizard";
import { goTo } from "./redirect";
import {
  failedDeliveriesQueryOptions,
  repositoryKeys,
  repositoryQueryOptions
} from "./query-options";
import {
  REPOSITORY_ATTEMPT_KEY,
  callbackErrorMessage,
  providerLabels
} from "./repository-copy";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
});
const when = (value: string | null) =>
  value ? dateFormat.format(new Date(value)) : "Not yet";

function actionError(error: unknown) {
  if (!(error instanceof DashboardApiError))
    return "That didn’t work. Try again.";
  if (error.kind === "REPOSITORY_NOT_CONFIGURED")
    return "This provider isn’t set up on this server.";
  if (error.kind === "PERMISSION_DENIED")
    return "Only project owners and admins can change the repository.";
  if (error.kind === "NETWORK_ERROR")
    return "We couldn’t reach the Dashboard API. Check your connection and try again.";
  return error.message;
}

function FailedDeliveries({
  api,
  projectId
}: {
  api: ApiClient;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const deliveries = useQuery(failedDeliveriesQueryOptions(api, projectId));
  const retry = useMutation({
    mutationFn: (id: string) => api.retryRepositoryDelivery(projectId, id),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: repositoryKeys.project(projectId)
      })
  });
  if (deliveries.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading failed deliveries…
      </p>
    );
  if (deliveries.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        {actionError(deliveries.error)}
      </p>
    );
  return (
    <ul className="flex flex-col divide-y rounded-lg border">
      {deliveries.data.deliveries.map((delivery) => (
        <li
          key={delivery.id}
          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
        >
          <span className="min-w-0">
            <span className="block font-medium">{delivery.event_type}</span>
            <span className="block text-xs text-muted-foreground">
              {when(delivery.received_at)} · {delivery.attempts}{" "}
              {delivery.attempts === 1 ? "attempt" : "attempts"}
              {delivery.last_error ? ` · ${delivery.last_error}` : ""}
            </span>
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={retry.isPending}
            onClick={() => retry.mutate(delivery.id)}
          >
            Retry
          </Button>
        </li>
      ))}
    </ul>
  );
}

type Confirmation = "disconnect" | "reconnect";

// Settings › Repository. Owners and admins connect, sync and disconnect;
// members see the status.
export function RepositorySettingsSection({
  api,
  projectId,
  authorizationId,
  callbackError,
  onWizardClosed
}: {
  api: ApiClient;
  projectId: string;
  /** `?repository_authorization=` after a provider redirect. */
  authorizationId?: string;
  /** `?repository_error=` after a failed provider redirect. */
  callbackError?: string;
  onWizardClosed: () => void;
}) {
  const queryClient = useQueryClient();
  const platform = usePlatform();
  const { canManage, projectArchived } = useBranch();
  const [notice, setNotice] = useState<string | null>(null);
  const [showFailed, setShowFailed] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const repository = useQuery(repositoryQueryOptions(api, projectId));
  const canAct = canManage && !projectArchived;
  const refresh = () =>
    Promise.all([
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
  const start = useMutation({
    mutationFn: (provider: RepositoryProvider) =>
      api.authorizeRepository(projectId, {
        provider,
        return_path: `/projects/${projectId}/settings`
      }),
    onSuccess: async (authorization, provider) => {
      // The GitHub Setup URL comes back without our state; this attempt
      // is how the setup route finds its way.
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
        setNotice(
          `Finish connecting ${providerLabels[provider]} in your browser.`
        );
      } else goTo(authorization.authorize_url);
    }
  });
  const sync = useMutation({
    mutationFn: () => api.syncRepository(projectId),
    onSuccess: () => setNotice("Sync requested. Branches update shortly.")
  });
  const reenable = useMutation({
    mutationFn: () => api.reenableRepositoryHook(projectId),
    onSuccess: async () => {
      setNotice("GitLab sent a test delivery to wake the webhook.");
      await refresh();
    }
  });
  const disconnect = useMutation({
    mutationFn: async (kind: Confirmation) => {
      const provider = repository.data?.repository?.provider;
      await api.disconnectRepository(projectId);
      return { kind, provider };
    },
    onSuccess: async ({ kind, provider }) => {
      setConfirmation(null);
      await refresh();
      if (kind === "reconnect" && provider) start.mutate(provider);
    }
  });
  // A disconnect failure shows in its dialog, which covers the card.
  const failure = start.error ?? sync.error ?? reenable.error;
  const confirm = (next: Confirmation) => {
    disconnect.reset();
    setConfirmation(next);
  };
  if (repository.isPending)
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Repository</h2>
          </CardTitle>
          <CardDescription>Loading the repository connection…</CardDescription>
        </CardHeader>
      </Card>
    );
  const connection: RepositoryConnection | null =
    repository.data?.repository ?? null;
  const providers = repository.data?.providers ?? [];
  const hookDisabled =
    connection?.provider === "gitlab" &&
    connection.hook_health?.alert_status &&
    connection.hook_health.alert_status !== "executable";
  return (
    <Card id="repository" className="scroll-mt-4">
      <CardHeader>
        <CardTitle>
          <h2>Repository</h2>
        </CardTitle>
        <CardDescription>
          A connected repository creates a branch here for each Git branch,
          archives it when the branch is deleted, and merges work when a pull
          request merges. Nothing here changes your code.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {callbackError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {callbackErrorMessage(callbackError)}
            </AlertDescription>
          </Alert>
        ) : null}
        {notice ? (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        ) : null}
        {repository.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {actionError(repository.error)}
          </p>
        ) : connection ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                <span className="font-medium">
                  {connection.url ? (
                    <a
                      href={connection.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4"
                    >
                      {connection.full_name}
                    </a>
                  ) : (
                    connection.full_name
                  )}
                </span>{" "}
                <span className="text-muted-foreground">
                  on {providerLabels[connection.provider]}
                </span>
              </p>
              <StatusBadge status={connection.status} />
            </div>
            {connection.status_reason && connection.status !== "active" ? (
              <p className="text-sm text-muted-foreground">
                {connection.status_reason}
              </p>
            ) : null}
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">
                  Default branch
                </dt>
                <dd className="mt-1">
                  Tracks {connection.provider_default_branch}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last event</dt>
                <dd className="mt-1">{when(connection.last_event_at)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Last sync</dt>
                <dd className="mt-1">{when(connection.last_reconciled_at)}</dd>
              </div>
            </dl>
            {hookDisabled ? (
              <Alert>
                <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span>
                    GitLab paused the webhook after failed deliveries
                    {connection.hook_health?.disabled_until
                      ? ` until ${when(connection.hook_health.disabled_until)}`
                      : ""}
                    . Branch changes arrive with the next sync until it’s back.
                  </span>
                  {canAct ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={reenable.isPending}
                      onClick={() => reenable.mutate()}
                    >
                      Re-enable
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
            {connection.failed_delivery_count ? (
              <div className="flex flex-col gap-2">
                {canAct ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="self-start"
                    aria-expanded={showFailed}
                    onClick={() => setShowFailed((open) => !open)}
                  >
                    Failed deliveries ({connection.failed_delivery_count})
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {connection.failed_delivery_count} failed{" "}
                    {connection.failed_delivery_count === 1
                      ? "delivery"
                      : "deliveries"}
                  </p>
                )}
                {showFailed && canAct ? (
                  <FailedDeliveries api={api} projectId={projectId} />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              No repository is connected.
              {canAct ? "" : " Owners and admins can connect one."}
            </p>
            {canAct ? (
              <div className="flex flex-col gap-2">
                {providers.map((provider) => (
                  <div
                    key={provider.provider}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1"
                  >
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!provider.configured || start.isPending}
                      aria-describedby={
                        provider.configured
                          ? undefined
                          : `provider-${provider.provider}-reason`
                      }
                      onClick={() => start.mutate(provider.provider)}
                    >
                      Connect {providerLabels[provider.provider]}
                    </Button>
                    {provider.unavailable_reason ? (
                      <span
                        id={`provider-${provider.provider}-reason`}
                        className="text-xs text-muted-foreground"
                      >
                        {provider.unavailable_reason}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {actionError(failure)}
          </p>
        ) : null}
      </CardContent>
      {connection && canAct ? (
        <CardFooter className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            Sync now
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => confirm("reconnect")}
          >
            Reconnect
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => confirm("disconnect")}
          >
            Disconnect
          </Button>
        </CardFooter>
      ) : null}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !disconnect.isPending) setConfirmation(null);
        }}
      >
        {confirmation && connection ? (
          <DialogContent showCloseButton={!disconnect.isPending}>
            <DialogHeader>
              <DialogTitle>
                {confirmation === "disconnect"
                  ? `Disconnect ${connection.full_name}?`
                  : `Reconnect ${connection.full_name}?`}
              </DialogTitle>
              <DialogDescription>
                {confirmation === "disconnect"
                  ? "Branches and their work are kept. Orchestrat stops following the repository until you connect again."
                  : `This disconnects the repository and connects it again with a fresh ${providerLabels[connection.provider]} authorization. Branches and their work are kept.`}
              </DialogDescription>
            </DialogHeader>
            {disconnect.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {actionError(disconnect.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={disconnect.isPending}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate(confirmation)}
              >
                {disconnect.isPending
                  ? "Disconnecting…"
                  : confirmation === "disconnect"
                    ? "Disconnect"
                    : "Reconnect"}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
      {authorizationId && canAct && !connection ? (
        <ConnectWizard
          api={api}
          projectId={projectId}
          authorizationId={authorizationId}
          onClose={onWizardClosed}
        />
      ) : null}
    </Card>
  );
}
