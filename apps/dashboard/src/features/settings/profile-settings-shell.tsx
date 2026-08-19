import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WindowDragRegion } from "@/components/app-shell/top-toolbar";
import { usePreferences } from "@/platform/preferences-provider";

export function ProfileSettingsShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { preferences } = usePreferences();
  const dashboardProjectId =
    preferences.recentProjectIds[0] ?? preferences.pinnedProjectIds[0];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background md:flex-row">
      <aside
        className="flex w-full shrink-0 flex-col border-b bg-muted/20 md:w-64 md:border-r md:border-b-0 pt-10"
        aria-label="Settings"
      >
        <header className="relative flex h-10 shrink-0 items-center border-b px-3 select-none">
          <WindowDragRegion />
          <Button
            type="button"
            variant="ghost"
            className="relative z-10 gap-2 px-2"
            onClick={() =>
              void (dashboardProjectId
                ? navigate({
                    to: "/projects/$projectId/overview",
                    params: { projectId: dashboardProjectId }
                  })
                : navigate({ to: "/setup" }))
            }
          >
            <ArrowLeft aria-hidden="true" />
            Back to dashboard
          </Button>
        </header>
        <nav aria-label="Settings navigation" className="flex flex-col gap-1 p-3">
          <Link
            to="/profile"
            aria-current="page"
            className="rounded-md bg-muted px-3 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring"
          >
            Profile
          </Link>
        </nav>
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
