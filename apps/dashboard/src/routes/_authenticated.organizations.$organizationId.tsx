import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  createFileRoute,
  useLocation,
  useNavigate,
  useRouter
} from "@tanstack/react-router";
import type { Organization } from "@orchestrat/protocol";
import { OrganizationShell } from "@/components/app-shell/app-shell";
import type { OrganizationDestination } from "@/features/command/commands";
import type { ProjectCatalog } from "@/features/hierarchy/catalog";
import {
  hierarchyKeys,
  projectCatalogQueryOptions
} from "@/features/hierarchy/query-options";

export const Route = createFileRoute(
  "/_authenticated/organizations/$organizationId"
)({
  beforeLoad: async ({ context }) => ({
    catalog: await context.queryClient.fetchQuery(
      projectCatalogQueryOptions(context.api)
    )
  }),
  pendingComponent: OrganizationShellSkeleton,
  component: OrganizationLayout
});

function OrganizationShellSkeleton() {
  return (
    <div
      aria-label="Loading organization"
      className="grid h-dvh grid-cols-[256px_minmax(0,1fr)] overflow-hidden bg-background"
    >
      <aside className="border-r bg-sidebar" />
      <main className="p-8">
        <div className="h-8 w-40 animate-pulse rounded bg-muted" />
        <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div
              key={index}
              className="h-32 animate-pulse rounded-xl bg-muted"
            />
          ))}
        </div>
      </main>
    </div>
  );
}

/** The live catalog and the organization these pages belong to. The layout
 * renders its pages only once the organization is known. */
export function useOrganizationRoute(): {
  catalog: ProjectCatalog;
  organization: Organization;
} {
  const { catalog: initialCatalog } = Route.useRouteContext();
  const { organizationId } = Route.useParams();
  const { api } = useRouter().options.context;
  const catalog =
    useQuery(projectCatalogQueryOptions(api)).data ?? initialCatalog;
  const organization = catalog.organizations.find(
    ({ id }) => id === organizationId
  );
  if (!organization)
    throw new Error("Organization route rendered without its organization.");
  return { catalog, organization };
}

function destinationOf(pathname: string): OrganizationDestination | undefined {
  if (pathname.endsWith("/members")) return "members";
  if (pathname.endsWith("/settings")) return "settings";
  if (pathname.endsWith("/projects/new")) return undefined;
  return "projects";
}

function OrganizationLayout() {
  const { catalog: initialCatalog } = Route.useRouteContext();
  const { organizationId } = Route.useParams();
  const router = useRouter();
  const navigate = useNavigate();
  const { pathname, hash, state } = useLocation();
  const { api, queryClient, auth } = router.options.context;
  const catalogQuery = useQuery({
    ...projectCatalogQueryOptions(api),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true
  });
  const catalog = catalogQuery.data ?? initialCatalog;
  const profile = useQuery({
    queryKey: ["profile"],
    queryFn: () => api.getProfile()
  });
  const organization = catalog.organizations.find(
    ({ id }) => id === organizationId
  );
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (hash) return;
      // A page that focused its own field (New project) keeps that focus.
      if (
        document.activeElement?.matches("input, textarea, select") &&
        document
          .getElementById("main-content")
          ?.contains(document.activeElement)
      )
        return;
      document
        .querySelector<HTMLElement>("[data-slot='top-toolbar-page']")
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname, state.key, hash]);
  if (!organization)
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Organization unavailable
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This organization doesn’t exist or you’re no longer a member.
        </p>
        <Link
          to="/setup"
          className="mt-6 w-fit text-sm font-medium underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Go to your workspace
        </Link>
      </main>
    );
  const destination = destinationOf(pathname);
  return (
    <OrganizationShell
      catalog={catalog}
      organization={organization}
      activeDestination={destination}
      pageTitle={destination ? undefined : "New project"}
      navigateToOrganization={(id, page) =>
        navigate(
          page === "projects"
            ? {
                to: "/organizations/$organizationId",
                params: { organizationId: id }
              }
            : {
                to: `/organizations/$organizationId/${page}`,
                params: { organizationId: id }
              }
        )
      }
      navigateToProject={(projectId) =>
        navigate({
          to: "/projects/$projectId/overview",
          params: { projectId },
          search: { branch: undefined }
        })
      }
      openPreferences={() => navigate({ to: "/profile" })}
      signOut={() => auth.signOut()}
      profile={profile.data}
      retryCatalog={async () => {
        await queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
        await router.invalidate();
      }}
    >
      <Outlet />
    </OrganizationShell>
  );
}
