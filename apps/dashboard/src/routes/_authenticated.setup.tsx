import { createFileRoute } from "@tanstack/react-router";
import { SetupFlow } from "@/features/hierarchy/setup-flow";

function SetupRoute() {
  return (
    <main className="min-h-screen bg-background px-6 py-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-16">
        <div className="text-sm font-semibold tracking-tight">Orchestrat</div>
        <SetupFlow />
      </div>
    </main>
  );
}

export const Route = createFileRoute("/_authenticated/setup")({
  component: SetupRoute
});
