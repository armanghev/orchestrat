import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createProjectRequestSchema } from "@orchestrat/protocol";
import {
  CreationForm,
  type CreationInput
} from "@/features/hierarchy/creation-form";
import { hierarchyKeys } from "@/features/hierarchy/query-options";
import { useOrganizationRoute } from "./_authenticated.organizations.$organizationId";

// ponytail: the plain project form; ORC-55 adds the Git source picker.
function NewProject() {
  const { organization } = useOrganizationRoute();
  const router = useRouter();
  const { api, queryClient } = router.options.context;
  const create = useMutation({
    mutationFn: (input: CreationInput) =>
      api.createProject(
        organization.id,
        createProjectRequestSchema.parse({
          name: input.name,
          description: input.description ?? null
        })
      )
  });
  return (
    <div className="dashboard-page">
      <CreationForm
        kind="project"
        title="Create a project"
        description={`Create a project in ${organization.name}.`}
        pending={create.isPending}
        onSubmit={async (input) => {
          const created = await create.mutateAsync(input);
          await queryClient.invalidateQueries({
            queryKey: hierarchyKeys.all,
            refetchType: "none"
          });
          await router.navigate({
            to: "/projects/$projectId/overview",
            params: { projectId: created.id },
            search: { branch: undefined }
          });
        }}
      />
    </div>
  );
}

export const Route = createFileRoute(
  "/_authenticated/organizations/$organizationId/projects/new"
)({ component: NewProject });
