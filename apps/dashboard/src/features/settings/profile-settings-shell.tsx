import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WindowDragRegion } from "@/components/app-shell/top-toolbar";

export function ProfileSettingsShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="relative flex h-10 shrink-0 items-center border-b px-3 select-none">
        <WindowDragRegion />
        <div className="relative z-10 flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Back to dashboard"
            onClick={() => void navigate({ to: "/" })}
          >
            <ArrowLeft />
          </Button>
          <span className="text-sm font-medium">Profile settings</span>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
