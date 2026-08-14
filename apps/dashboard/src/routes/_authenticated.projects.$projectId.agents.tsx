import { createFileRoute } from "@tanstack/react-router";
import { UnavailableFeaturePage } from "@/features/unavailable/unavailable-feature";
function AgentsRoute() { const { projectId } = Route.useParams(); return <UnavailableFeaturePage feature="Agents" projectId={projectId} />; }
export const Route = createFileRoute("/_authenticated/projects/$projectId/agents")({ component: AgentsRoute });
