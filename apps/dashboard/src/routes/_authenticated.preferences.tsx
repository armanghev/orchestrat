import { createFileRoute } from "@tanstack/react-router";
import { PreferencesPage } from "@/features/preferences/preferences-page";
import { usePreferences } from "@/platform/preferences-provider";
function PreferencesRoute() { const { preferences } = usePreferences(); return <PreferencesPage recentProjectId={preferences.recentProjectIds[0]} />; }
export const Route = createFileRoute("/_authenticated/preferences")({ component: PreferencesRoute });
