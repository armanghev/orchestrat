import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { ProjectSettingsPage } from "@/features/settings/project-settings-page";
import { hierarchyKeys } from "@/features/hierarchy/query-options";
import { Route as ProjectRoute } from "./_authenticated.projects.$projectId";
function SettingsRoute() {
  const { project } = ProjectRoute.useRouteContext();
  const router = useRouter();
  const navigate = useNavigate();
  const { api, queryClient } = router.options.context;
  if (!project) return null;
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
    await router.invalidate();
  };
  const leaveProject = async () => {
    await queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
    await navigate({ to: "/" });
  };
  return (
    <ProjectSettingsPage
      context={project}
      api={api}
      onUpdated={() => void refresh()}
      onDeleted={() => void leaveProject()}
    />
  );
}
export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/settings"
)({ component: SettingsRoute });
