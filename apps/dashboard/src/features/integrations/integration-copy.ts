import type { QueryClient } from "@tanstack/react-query";
import type {
  IntegrationProvider,
  OrganizationIntegration,
  OrganizationRepository
} from "@orchestrat/protocol";
import { DashboardApiError } from "@/lib/api/client";
import {
  hierarchyKeys,
  integrationKeys
} from "@/features/hierarchy/query-options";
import { REPOSITORY_ATTEMPT_KEY } from "@/features/repository/repository-copy";

export const integrationProviders: IntegrationProvider[] = ["github", "gitlab"];

export function selectionLabel(integration: OrganizationIntegration) {
  if (integration.repository_selection === "all") return "All repositories";
  const count = integration.selected_repository_ids.length;
  return count > 0
    ? `Selected repositories (${count})`
    : "Selected repositories";
}

export function statusLabel(integration: OrganizationIntegration) {
  if (integration.status === "needs_reauthorization")
    return "Needs reauthorization";
  if (integration.status === "suspended") return "Suspended";
  return null;
}

export function integrationErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof DashboardApiError)) return fallback;
  if (error.kind === "REPOSITORY_NOT_CONFIGURED")
    return "This provider isn’t set up on this server.";
  if (error.kind === "PERMISSION_DENIED")
    return "Only organization owners and admins can manage Git integrations.";
  if (error.kind === "NETWORK_ERROR")
    return "We couldn’t reach the Dashboard API. Check your connection and try again.";
  return error.message || fallback;
}

/** The repository's own name: the last segment of its full name. */
export function repositoryShortName(fullName: string) {
  return fullName.split("/").filter(Boolean).at(-1) ?? fullName;
}

/** Most recently pushed first, then most recently seen. */
export function sortRepositories(repositories: OrganizationRepository[]) {
  const time = (value: string | null) =>
    value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
  return [...repositories].sort(
    (a, b) =>
      time(b.pushed_at) - time(a.pushed_at) ||
      time(b.first_seen_at) - time(a.first_seen_at) ||
      a.full_name.localeCompare(b.full_name)
  );
}

/** Integrations and every repository list (importable and all). */
export function invalidateIntegrations(
  queryClient: QueryClient,
  organizationId: string
) {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: integrationKeys.all(organizationId)
    }),
    queryClient.invalidateQueries({
      queryKey: [
        ...hierarchyKeys.all,
        "organizations",
        organizationId,
        "repositories"
      ]
    })
  ]);
}

/** The pending organization attempt, for GitHub's Setup URL and Try again. */
export function writeOrganizationAttempt(attempt: {
  authorization_id: string;
  organization_id: string;
  provider: IntegrationProvider;
}) {
  window.sessionStorage.setItem(
    REPOSITORY_ATTEMPT_KEY,
    JSON.stringify({
      authorization_id: attempt.authorization_id,
      organization_id: attempt.organization_id,
      project_id: null,
      provider: attempt.provider,
      return_path: `/organizations/${attempt.organization_id}/integrations`
    })
  );
}

export function readOrganizationAttemptProvider(
  organizationId: string
): IntegrationProvider | null {
  try {
    const attempt = JSON.parse(
      window.sessionStorage.getItem(REPOSITORY_ATTEMPT_KEY) ?? "null"
    ) as { organization_id?: string; provider?: string } | null;
    if (attempt?.organization_id !== organizationId) return null;
    return attempt.provider === "github" || attempt.provider === "gitlab"
      ? attempt.provider
      : null;
  } catch {
    return null;
  }
}
