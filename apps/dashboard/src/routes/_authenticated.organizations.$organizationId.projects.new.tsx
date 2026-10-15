import { createFileRoute, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { CreateProjectPage } from "@/features/hierarchy/create-project-page";
import { useOrganizationRoute } from "./_authenticated.organizations.$organizationId";

function NewProject() {
  const { organization } = useOrganizationRoute();
  const { api } = useRouter().options.context;
  const { repository } = Route.useSearch();
  return (
    <CreateProjectPage
      api={api}
      organization={organization}
      repositoryId={repository}
    />
  );
}

export const Route = createFileRoute(
  "/_authenticated/organizations/$organizationId/projects/new"
)({
  // Import mode: an organization repository to create the project from.
  validateSearch: z.object({
    repository: z.string().uuid().optional().catch(undefined)
  }),
  component: NewProject
});
