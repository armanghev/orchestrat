import { createFileRoute } from "@tanstack/react-router";
import { ProjectSettingsPage } from "@/features/settings/project-settings-page";
import { Route as ProjectRoute } from "./_authenticated.projects.$projectId";
function SettingsRoute() { const { project } = ProjectRoute.useRouteContext(); return project ? <ProjectSettingsPage context={project} /> : null; }
export const Route = createFileRoute("/_authenticated/projects/$projectId/settings")({ component: SettingsRoute });
