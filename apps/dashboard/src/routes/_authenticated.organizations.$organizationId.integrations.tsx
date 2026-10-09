import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { useOrganizationRoute } from "./_authenticated.organizations.$organizationId";

// ponytail: placeholder; the integrations UI replaces this page.
function OrganizationIntegrations() {
  const { organization } = useOrganizationRoute();
  return (
    <section className="dashboard-page" aria-label="Integrations">
      <p className="text-sm text-muted-foreground">
        Git integrations for {organization.name}.
      </p>
    </section>
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
