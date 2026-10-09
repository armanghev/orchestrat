import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import type {
  Organization,
  OrganizationRepository
} from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/features/attention/attention-copy";
import {
  organizationIntegrationsQueryOptions,
  organizationRepositoriesQueryOptions
} from "@/features/hierarchy/query-options";
import { providerLabels } from "@/features/repository/repository-copy";
import type { ApiClient } from "@/lib/api/client";
import {
  integrationErrorMessage,
  invalidateIntegrations,
  sortRepositories
} from "./integration-copy";

const COLLAPSED_COUNT = 5;

/** Organization home: repositories the integrations reach that aren't
 * projects yet (owners and admins). */
export function ImportRepositoriesPanel({
  api,
  organization
}: {
  api: ApiClient;
  organization: Organization;
}) {
  const organizationId = organization.id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const now = useMemo(() => Date.now(), []);
  const [expanded, setExpanded] = useState(false);
  const integrations = useQuery(
    organizationIntegrationsQueryOptions(api, organizationId)
  );
  const repositories = useQuery(
    organizationRepositoriesQueryOptions(api, organizationId, "importable")
  );
  const dismiss = useMutation({
    mutationFn: (repository: OrganizationRepository) =>
      api.dismissOrganizationRepository(organizationId, repository.id),
    onSuccess: () => invalidateIntegrations(queryClient, organizationId)
  });
  const sorted = useMemo(
    () => sortRepositories(repositories.data?.repositories ?? []),
    [repositories.data]
  );

  if (integrations.isPending || repositories.isPending)
    return (
      <div aria-label="Loading repositories to import" className="grid gap-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-12 rounded-xl" />
      </div>
    );
  if (integrations.isError || repositories.isError)
    return (
      <div role="alert" className="flex items-center gap-3 text-sm">
        We couldn’t load repositories to import.
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (integrations.isError) void integrations.refetch();
            if (repositories.isError) void repositories.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  if (integrations.data.integrations.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        <Link
          to="/organizations/$organizationId/integrations"
          params={{ organizationId }}
          search={{
            repository_authorization: undefined,
            repository_error: undefined
          }}
          className="underline-offset-2 hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
        >
          Connect GitHub or GitLab to import repositories
        </Link>
      </p>
    );
  if (sorted.length === 0) return null;

  const shown = expanded ? sorted : sorted.slice(0, COLLAPSED_COUNT);
  return (
    <section
      aria-labelledby="import-repositories"
      className="grid gap-3 rounded-xl p-4 ring-1 ring-border"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="import-repositories" className="text-base font-medium">
          Import Git repository
        </h2>
        <Link
          to="/organizations/$organizationId/integrations"
          params={{ organizationId }}
          search={{
            repository_authorization: undefined,
            repository_error: undefined
          }}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
        >
          Manage integrations
        </Link>
      </div>
      <ul className="divide-y" aria-label="Repositories to import">
        {shown.map((repository) => (
          <li
            key={repository.id}
            className="flex min-w-0 items-center gap-3 py-2 first:pt-0 last:pb-0"
          >
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-sm font-medium">
                  {repository.full_name}
                </span>
                {repository.is_new ? (
                  <span className="shrink-0 text-xs font-medium">New</span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {providerLabels[repository.provider]}
                {repository.pushed_at
                  ? ` · Pushed ${relativeTime(repository.pushed_at, now)}`
                  : null}
              </span>
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Import ${repository.full_name}`}
              onClick={() =>
                void navigate({
                  to: "/organizations/$organizationId/projects/new",
                  params: { organizationId },
                  search: { repository: repository.id }
                })
              }
            >
              Import
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Dismiss ${repository.full_name}`}
              disabled={
                dismiss.isPending && dismiss.variables.id === repository.id
              }
              onClick={() => dismiss.mutate(repository)}
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
      {dismiss.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {integrationErrorMessage(
            dismiss.error,
            "We couldn’t dismiss that repository. Try again."
          )}
        </p>
      ) : null}
      {sorted.length > COLLAPSED_COUNT ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show fewer" : `Show all (${sorted.length})`}
        </Button>
      ) : null}
    </section>
  );
}
