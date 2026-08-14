import { createFileRoute } from "@tanstack/react-router";
import { OverviewPage } from "@/features/overview/overview-page";
import { Route as ProjectRoute } from "./_authenticated.projects.$projectId";
function OverviewRoute() { const { project } = ProjectRoute.useRouteContext(); return project ? <OverviewPage context={project} /> : null; }
export const Route = createFileRoute("/_authenticated/projects/$projectId/overview")({ component: OverviewRoute });
