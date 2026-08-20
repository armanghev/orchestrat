import { useEffect, useRef } from "react";
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useNavigate,
  useRouter
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell/app-shell";
import type { NavigationDestination } from "@/features/command/commands";
import {
  hierarchyKeys,
  projectCatalogQueryOptions
} from "@/features/hierarchy/query-options";
import { orderProjects } from "@/features/hierarchy/project-order";
import { usePreferences } from "@/platform/preferences-provider";
import { DashboardApiError } from "@/lib/api/client";

export const Route = createFileRoute("/_authenticated/projects/$projectId")({
  beforeLoad: async ({ context, params }) => {
    const catalog = await context.queryClient.fetchQuery(
      projectCatalogQueryOptions(context.api)
    );
    if (catalog.projects.length === 0 && catalog.failures.length === 0)
      throw redirect({ to: "/setup" });
    return {
      catalog,
      project:
        catalog.projects.find(
          ({ project }) => project.id === params.projectId
        ) ?? null
    };
  },
  pendingComponent: ProjectShellSkeleton,
  errorComponent: ProjectRouteError,
  component: ProjectLayout
});

function ProjectShellSkeleton() {
  return (
    <div
      aria-label="Loading project"
      className="grid h-dvh grid-cols-[64px_240px_minmax(0,1fr)] overflow-hidden bg-background"
    >
      <aside className="border-r bg-rail" />
      <aside className="border-r" />
      <main className="p-8">
        <div className="h-8 w-40 animate-pulse rounded bg-muted" />
        <div className="mt-8 space-y-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="h-12 animate-pulse rounded bg-muted" />
          ))}
        </div>
      </main>
    </div>
  );
}

function useHeadingFocus() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return heading;
}

async function reloadHierarchy(router: ReturnType<typeof useRouter>) {
  await router.options.context.queryClient.invalidateQueries({
    queryKey: hierarchyKeys.all
  });
  await router.invalidate();
}

function ProjectRouteError({
  error,
  reset
}: {
  error: unknown;
  reset: () => void;
}) {
  const router = useRouter();
  const heading = useHeadingFocus();
  const message =
    error instanceof DashboardApiError
      ? error.kind === "NETWORK_ERROR"
        ? "We couldn’t reach the Dashboard API. Check your connection and try again."
        : error.kind === "PERMISSION_DENIED"
          ? "You don’t have permission to access this project."
          : error.kind === "INVALID_RESPONSE"
            ? "Dashboard API returned data this app cannot use."
            : "We couldn’t load this project. Try again."
      : "We couldn’t load this project. Try again.";
  const retry = async () => {
    await router.options.context.queryClient.invalidateQueries({
      queryKey: hierarchyKeys.all
    });
    reset();
    await router.invalidate();
  };
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight"
      >
        Project unavailable
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      <button
        type="button"
        className="mt-6 w-fit text-sm font-medium underline focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          void retry();
        }}
      >
        Retry
      </button>
    </main>
  );
}

function ProjectCatalogUnavailable() {
  const router = useRouter();
  const heading = useHeadingFocus();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight"
      >
        Project catalog unavailable
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        We couldn’t load your project catalog. Try again.
      </p>
      <button
        type="button"
        className="mt-6 w-fit text-sm font-medium underline focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          void reloadHierarchy(router);
        }}
      >
        Retry
      </button>
    </main>
  );
}

function ProjectAccessUnavailable({
  requestedProjectId,
  catalog
}: {
  requestedProjectId: string;
  catalog: ReturnType<typeof Route.useRouteContext>["catalog"];
}) {
  const heading = useHeadingFocus();
  const first = catalog.projects[0];
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center p-6">
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight"
      >
        Project access unavailable
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Project <span className="font-mono">{requestedProjectId}</span> is not
        in your accessible project catalog.
      </p>
      <div className="mt-6 flex gap-4">
        <Link
          to="/projects/$projectId/overview"
          params={{ projectId: first.project.id }}
          className="text-sm font-medium underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Project switcher
        </Link>
        <Link
          to="/setup"
          className="text-sm font-medium underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Setup
        </Link>
      </div>
    </main>
  );
}

function ProjectLayout() {
  const { catalog, project } = Route.useRouteContext();
  const { projectId } = Route.useParams();
  const { preferences, update } = usePreferences();
  const navigate = useNavigate();
  const router = useRouter();
  const { api } = router.options.context;
  const profileQuery = useQuery({
    queryKey: ["profile"],
    queryFn: () => api.getProfile()
  });
  const location = useLocation();
  const route = location.pathname.split("/").at(-1) as NavigationDestination;
  useEffect(() => {
    if (!project) return;
    const ordered = orderProjects(
      catalog.projects.map(({ project: item }) => item.id),
      { ...preferences, selectedProjectId: project.project.id }
    );
    if (
      ordered.pinnedProjectIds.join("\0") !==
        preferences.pinnedProjectIds.join("\0") ||
      ordered.recentProjectIds.join("\0") !==
        preferences.recentProjectIds.join("\0")
    )
      void update({
        pinnedProjectIds: ordered.pinnedProjectIds,
        recentProjectIds: ordered.recentProjectIds
      });
  }, [catalog.projects, preferences, project, update]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (location.hash) return;
      document.querySelector<HTMLElement>("#main-content h1")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, location.state.key, location.hash]);
  if (!project)
    return catalog.failures.length > 0 ? (
      <ProjectCatalogUnavailable />
    ) : (
      <ProjectAccessUnavailable
        requestedProjectId={projectId}
        catalog={catalog}
      />
    );
  const navigateToProject = (id: string) =>
    navigate({
      to: "/projects/$projectId/overview",
      params: { projectId: id }
    });
  const navigateToRoute = (
    destination: NavigationDestination,
    id = project.project.id
  ) => navigate({ to: `/projects/${id}/${destination}` as never });
  return (
    <AppShell
      catalog={catalog}
      activeProjectId={project.project.id}
      activeRoute={route}
      navigateToProject={navigateToProject}
      navigateToRoute={navigateToRoute}
      openPreferences={() => navigate({ to: "/profile" as never })}
      signOut={() => router.options.context.auth.signOut()}
      profile={profileQuery.data}
      retryCatalog={() => reloadHierarchy(router)}
    >
      <Outlet />
    </AppShell>
  );
}
