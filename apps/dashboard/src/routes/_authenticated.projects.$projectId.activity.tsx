import { createFileRoute } from "@tanstack/react-router";
import { UnavailableFeaturePage } from "@/features/unavailable/unavailable-feature";
function ActivityRoute() {
  const { projectId } = Route.useParams();
  return <UnavailableFeaturePage feature="Activity" projectId={projectId} />;
}
export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/activity"
)({ component: ActivityRoute });
