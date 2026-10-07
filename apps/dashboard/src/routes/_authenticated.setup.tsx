import { useQuery } from "@tanstack/react-query";
import { Navigate, createFileRoute, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { resolveLanding } from "@/features/hierarchy/landing";
import {
  hierarchyKeys,
  projectCatalogQueryOptions
} from "@/features/hierarchy/query-options";
import { usePreferences } from "@/platform/preferences-provider";

// /setup only decides where a signed-in person lands; the pages it sends them
// to live under /organizations and /projects.
function SetupRoute() {
  const { create } = Route.useSearch();
  const router = useRouter();
  const { api, queryClient } = router.options.context;
  const { preferences, ready } = usePreferences();
  const catalog = useQuery(projectCatalogQueryOptions(api));
  if (catalog.isError)
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Organizations unavailable
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We couldn’t load your organizations. Try again.
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-6 w-fit"
          onClick={() =>
            void queryClient.invalidateQueries({ queryKey: hierarchyKeys.all })
          }
        >
          Retry
        </Button>
      </main>
    );
  if (!catalog.data || !ready)
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <p role="status" className="text-sm text-muted-foreground">
          Opening your workspace…
        </p>
      </main>
    );
  return (
    <Navigate {...resolveLanding(catalog.data, preferences, create)} replace />
  );
}

export const Route = createFileRoute("/_authenticated/setup")({
  validateSearch: z.object({
    create: z.enum(["organization", "project"]).optional()
  }),
  component: SetupRoute
});
