import { usePlatform } from "@/platform/provider";
import { cn } from "@/lib/cn";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WindowDragRegion } from "@/components/app-shell/top-toolbar";
import { usePreferences } from "@/platform/preferences-provider";

export function OrganizationSettingsShell({
  children
}: {
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const desktop = usePlatform().kind === "desktop";
  const { preferences } = usePreferences();
  const dashboardProjectId =
    preferences.recentProjectIds[0] ?? preferences.pinnedProjectIds[0];

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header
        className={cn(
          "relative flex h-14 shrink-0 items-center border-b px-4 select-none",
          desktop && "md:pl-22"
        )}
      >
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
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
