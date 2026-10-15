import { createFileRoute } from "@tanstack/react-router";
import { OrganizationHomePage } from "@/features/hierarchy/organization-home-page";
import { useOrganizationRoute } from "./_authenticated.organizations.$organizationId";

function OrganizationHome() {
  const { organization } = useOrganizationRoute();
  return <OrganizationHomePage organization={organization} />;
}

export const Route = createFileRoute(
  "/_authenticated/organizations/$organizationId/"
)({ component: OrganizationHome });
