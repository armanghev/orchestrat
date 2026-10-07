import {
  createFileRoute,
  useNavigate,
  useRouter
} from "@tanstack/react-router";
import { z } from "zod";
import { ProjectSettingsPage } from "@/features/settings/project-settings-page";
import { hierarchyKeys } from "@/features/hierarchy/query-options";
import { messagingKeys } from "@/features/messaging/query-options";
import { Route as ProjectRoute } from "./_authenticated.projects.$projectId";
function SettingsRoute() {
  const { project } = ProjectRoute.useRouteContext();
  const search = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate();
  const { api, queryClient } = router.options.context;
  if (!project) return null;
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
    await router.invalidate();
  };
  const refreshMembership = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: hierarchyKeys.all }),
      queryClient.invalidateQueries({
        queryKey: messagingKeys.candidates(project.project.id)
      })
    ]);
    await router.invalidate();
  };
  const leaveProject = async () => {
    await queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
    await navigate({
      to: "/organizations/$organizationId",
      params: { organizationId: project.organization.id }
    });
  };
  return (
    <ProjectSettingsPage
      context={project}
      api={api}
      onUpdated={() => void refresh()}
      onDeleted={() => void leaveProject()}
      onMembershipChanged={refreshMembership}
      repository={{
        authorizationId: search.repository_authorization,
        callbackError: search.repository_error,
        onWizardClosed: () =>
          void navigate({
            to: "/projects/$projectId/settings",
            params: { projectId: project.project.id },
            search: (current) => ({
              ...current,
              repository_authorization: undefined,
              repository_error: undefined
            })
          })
      }}
    />
  );
}
export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/settings"
)({
  // Provider callbacks return here (docs/project-branches.md §6.7).
  validateSearch: z.object({
    repository_authorization: z.string().optional(),
    repository_error: z.string().optional()
  }),
  component: SettingsRoute
});
