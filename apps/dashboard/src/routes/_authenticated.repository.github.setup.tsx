import { createFileRoute, useLocation } from "@tanstack/react-router";
import { z } from "zod";
import { GithubSetup } from "@/features/repository/github-setup";

function GithubSetupRoute() {
  const { api } = Route.useRouteContext();
  // The router parses numeric params as numbers, which would round large
  // installation ids; read the raw query instead.
  const { searchStr } = useLocation();
  const installationId =
    new URLSearchParams(searchStr).get("installation_id") ?? undefined;
  return <GithubSetup api={api} installationId={installationId} />;
}

export const Route = createFileRoute("/_authenticated/repository/github/setup")(
  {
    validateSearch: z.object({
      installation_id: z.union([z.string(), z.number()]).optional(),
      setup_action: z.string().optional()
    }),
    component: GithubSetupRoute
  }
);
