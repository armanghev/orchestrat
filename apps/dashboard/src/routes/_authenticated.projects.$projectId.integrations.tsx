import { createFileRoute } from "@tanstack/react-router";
import { UnavailableFeaturePage } from "@/features/unavailable/unavailable-feature";
function IntegrationsRoute() { const { projectId } = Route.useParams(); return <UnavailableFeaturePage feature="Integrations" projectId={projectId} />; }
export const Route = createFileRoute("/_authenticated/projects/$projectId/integrations")({ component: IntegrationsRoute });
