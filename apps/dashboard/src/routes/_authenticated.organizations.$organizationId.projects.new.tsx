import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CreateProjectPage } from "@/features/hierarchy/create-project-page";
import { useOrganizationRoute } from "./_authenticated.organizations.$organizationId";

function NewProject() {
  const { organization } = useOrganizationRoute();
  const { api } = useRouter().options.context;
  return <CreateProjectPage api={api} organization={organization} />;
}

export const Route = createFileRoute(
  "/_authenticated/organizations/$organizationId/projects/new"
)({ component: NewProject });
