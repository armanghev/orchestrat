import { createFileRoute } from "@tanstack/react-router";
import { DecisionsPage } from "@/features/decisions/decisions-page";

function DecisionsRoute() {
  const { projectId } = Route.useParams();
  const { api } = Route.useRouteContext();
  return <DecisionsPage api={api} projectId={projectId} />;
}

export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/decisions"
)({ component: DecisionsRoute });
