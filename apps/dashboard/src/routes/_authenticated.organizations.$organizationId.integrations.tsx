import { createFileRoute, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { IntegrationsPage } from "@/features/integrations/integrations-page";
import { useOrganizationRoute } from "./_authenticated.organizations.$organizationId";

function OrganizationIntegrations() {
  const { organization } = useOrganizationRoute();
  const { api } = useRouter().options.context;
  const search = Route.useSearch();
  return (
    <IntegrationsPage
      api={api}
      organization={organization}
      authorizationId={search.repository_authorization}
      callbackError={search.repository_error}
    />
  );
}

export const Route = createFileRoute(
  "/_authenticated/organizations/$organizationId/integrations"
)({
  // The provider returns here with the authorization (or an error) after
  // an owner or admin approves access.
  validateSearch: z.object({
    repository_authorization: z.string().optional(),
    repository_error: z.string().optional()
  }),
  component: OrganizationIntegrations
});
