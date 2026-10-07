import { createFileRoute, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { ConnectPage } from "@/features/repository/connect-page";
import { Route as ProjectRoute } from "./_authenticated.projects.$projectId";

function ConnectRoute() {
  const { project } = ProjectRoute.useRouteContext();
  const search = Route.useSearch();
  const { api } = useRouter().options.context;
  if (!project) return null;
  return (
    <ConnectPage
      api={api}
      projectId={project.project.id}
      authorizationId={search.repository_authorization}
      callbackError={search.repository_error}
    />
  );
}

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/connect"
)({
  // Provider callbacks for the creation flow land here (plan §Pages → Connect).
  validateSearch: z.object({
    repository_authorization: z.string().optional(),
    repository_error: z.string().optional()
  }),
  component: ConnectRoute
});
