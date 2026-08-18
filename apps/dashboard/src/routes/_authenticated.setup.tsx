import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { SetupFlow } from "@/features/hierarchy/setup-flow";

function SetupRoute() {
  const { create } = Route.useSearch();
  return (
    <main className="min-h-screen bg-background px-6 py-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-16">
        <div className="flex items-center gap-3">
          {create && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => window.history.back()}
            >
              Back
            </Button>
          )}
          <div className="text-sm font-semibold tracking-tight">Orchestrat</div>
        </div>
        <SetupFlow create={create} />
      </div>
    </main>
  );
}

export const Route = createFileRoute("/_authenticated/setup")({
  validateSearch: z.object({
    create: z.enum(["organization", "project"]).optional()
  }),
  component: SetupRoute
});
