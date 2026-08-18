import { createFileRoute } from "@tanstack/react-router";
import { UnavailableFeaturePage } from "@/features/unavailable/unavailable-feature";
function DocumentsRoute() {
  const { projectId } = Route.useParams();
  return <UnavailableFeaturePage feature="Documents" projectId={projectId} />;
}
export const Route = createFileRoute(
  "/_authenticated/projects/$projectId/documents"
)({ component: DocumentsRoute });
