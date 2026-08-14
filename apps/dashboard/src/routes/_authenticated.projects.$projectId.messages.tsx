import { createFileRoute } from "@tanstack/react-router";
import { UnavailableFeaturePage } from "@/features/unavailable/unavailable-feature";
function MessagesRoute() { const { projectId } = Route.useParams(); return <UnavailableFeaturePage feature="Messages" projectId={projectId} />; }
export const Route = createFileRoute("/_authenticated/projects/$projectId/messages")({ component: MessagesRoute });
