import { createFileRoute } from "@tanstack/react-router";
import { UnavailableFeaturePage } from "@/features/unavailable/unavailable-feature";
function TasksRoute() {
  const { projectId } = Route.useParams();
  return <UnavailableFeaturePage feature="Tasks" projectId={projectId} />;
}
export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/tasks"
)({ component: TasksRoute });
