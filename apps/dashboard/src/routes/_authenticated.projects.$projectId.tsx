import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  retainSearchParams,
  useLocation,
  useNavigate,
  useRouter
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type { Branch } from "@orchestrat/protocol";
import { AppShell } from "@/components/app-shell/app-shell";
import type { NavigationDestination } from "@/features/command/commands";
import type { ProjectContext } from "@/features/hierarchy/catalog";
import {
  hierarchyKeys,
  projectCatalogQueryOptions
} from "@/features/hierarchy/query-options";
import { orderProjects } from "@/features/hierarchy/project-order";
import {
  BranchProvider,
  type BranchContextValue
} from "@/features/branches/branch-context";
import {
  branchesQueryOptions,
  defaultBranchOf,
  resolveBranch
} from "@/features/branches/query-options";
import { useUnreadBranchIds } from "@/features/branches/branch-selector";
import { CreateBranchDialog } from "@/features/branches/create-branch-dialog";
import { AllBranchesDialog } from "@/features/branches/all-branches-dialog";
import {
  ImportDialog,
  type ImportRequest
} from "@/features/branches/import-dialog";
import { usePreferences } from "@/platform/preferences-provider";
import { DashboardApiError } from "@/lib/api/client";

export const Route = createFileRoute("/_authenticated/projects/$projectId")({
  // The branch is a search param holding its id, since names are reused and
  // the default can be renamed. Without it a page shows the default branch,
  // so every older link stays valid (docs/project-branches.md §11.1).
  validateSearch: z.object({ branch: z.string().optional() }),
  search: { middlewares: [retainSearchParams(["branch"])] },
  beforeLoad: async ({ context, params }) => {
    const catalog = await context.queryClient.fetchQuery(
      projectCatalogQueryOptions(context.api)
    );
    if (catalog.projects.length === 0 && catalog.failures.length === 0)
      throw redirect({ to: "/setup" });
    const project =
      catalog.projects.find(({ project }) => project.id === params.projectId) ??
      null;
    // Pages name their branch in their first query, so branches load first.
    const branches = project
      ? (
          await context.queryClient.fetchQuery(
            branchesQueryOptions(context.api, params.projectId)
          )
        ).branches
      : [];
    return { catalog, project, branches };
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
          search={{ branch: undefined }}
          className="text-sm font-medium underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Project switcher
        </Link>
        <Link
          to="/setup"
          className="text-sm font-medium underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Your workspace
        </Link>
      </div>
    </main>
  );
}

function BranchUnavailable({
  projectName,
  onShowDefault
}: {
  projectName: string;
  onShowDefault: () => void;
}) {
  const heading = useHeadingFocus();
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center p-6">
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight"
      >
        Branch unavailable
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This branch isn’t part of {projectName}. The link may be wrong, or you
        may no longer have access.
      </p>
      <button
        type="button"
        className="mt-6 w-fit text-sm font-medium underline focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onShowDefault}
      >
        Go to default branch
      </button>
    </main>
  );
}

function ProjectBranchScope({
  context,
  branches,
  branch,
  children
}: {
  context: ProjectContext;
  branches: Branch[];
  branch: Branch;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { api } = useRouter().options.context;
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [importing, setImporting] = useState<ImportRequest | null>(null);
  const projectId = context.project.id;
  const unread = useUnreadBranchIds(api, projectId);
  const defaultBranch = defaultBranchOf(branches);
  // Switching keeps the page but drops entity params (?task=, ?document=,
  // ?chat=), which name items of the branch being left.
  const selectBranch = useCallback(
    (branchId: string) =>
      void navigate({
        to: pathname as never,
        search: {
          branch: branchId === defaultBranch?.id ? undefined : branchId
        } as never
      }),
    [defaultBranch?.id, navigate, pathname]
  );
  const value = useMemo<BranchContextValue>(() => {
    const projectArchived = context.project.status === "archived";
    const branchArchived = Boolean(branch.archived_at);
    const names = new Map(branches.map((item) => [item.id, item.name]));
    return {
      projectId,
      branches,
      branch,
      branchId: branch.id,
      defaultBranch,
      projectArchived,
      branchArchived,
      readOnly: projectArchived || branchArchived,
      canManage:
        context.project.role === "owner" || context.project.role === "admin",
      branchName: (id) => (id ? names.get(id) : undefined),
      selectBranch,
      branchParam: (id) => (id === defaultBranch?.id ? undefined : id),
      openCreateBranch: () => setCreating(true),
      openAllBranches: () => setBrowsing(true),
      openImport: setImporting
    };
  }, [branch, branches, context, defaultBranch, projectId, selectBranch]);
  return (
    <BranchProvider value={value}>
      {children}
      <CreateBranchDialog
        api={api}
        projectId={projectId}
        open={creating}
        onOpenChange={setCreating}
        onCreated={(created) => selectBranch(created.id)}
      />
      <AllBranchesDialog
        open={browsing}
        onOpenChange={setBrowsing}
        branches={branches}
        currentBranchId={branch.id}
        unreadBranchIds={unread}
        onSelect={selectBranch}
      />
      {importing ? (
        <ImportDialog
          api={api}
          projectId={projectId}
          request={importing}
          onClose={() => setImporting(null)}
        />
      ) : null}
    </BranchProvider>
  );
}

function ProjectLayout() {
  const { catalog: initialCatalog, branches: initialBranches } =
    Route.useRouteContext();
  const { projectId } = Route.useParams();
  const { branch: requestedBranchId } = Route.useSearch();
  const { preferences, update } = usePreferences();
  const navigate = useNavigate();
  const router = useRouter();
  const { api } = router.options.context;
  const catalogQuery = useQuery({
    ...projectCatalogQueryOptions(api),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true
  });
  const catalog = catalogQuery.data ?? initialCatalog;
  const project =
    catalog.projects.find(({ project: item }) => item.id === projectId) ?? null;
  const branchesQuery = useQuery({
    ...branchesQueryOptions(api, projectId),
    enabled: Boolean(project)
  });
  const branches = branchesQuery.data?.branches ?? initialBranches;
  const profileQuery = useQuery({
    queryKey: ["profile"],
    queryFn: () => api.getProfile()
  });
  const location = useLocation();
  const route = location.pathname.split("/").at(-1) as NavigationDestination;
  // Without ?branch= a page shows the default branch. When the default moves
  // (another admin, a repository connect), the page keeps the branch it
  // showed and names it in the URL, instead of switching under the person
  // and past the editor's unsaved-draft check (spec §11.1, §11.9).
  const shownDefault = useRef<{ projectId: string; branchId: string }>(null);
  const keptBranchId =
    !requestedBranchId &&
    shownDefault.current?.projectId === projectId &&
    shownDefault.current.branchId !== defaultBranchOf(branches)?.id &&
    branches.some((item) => item.id === shownDefault.current?.branchId)
      ? shownDefault.current.branchId
      : undefined;
  // Naming the branch on screen isn't a new page, so focus stays put.
  const namingBranch = useRef(false);
  useEffect(() => {
    if (requestedBranchId) {
      shownDefault.current = null;
      return;
    }
    if (keptBranchId) {
      if (namingBranch.current) return;
      namingBranch.current = true;
      void navigate({
        to: location.pathname as never,
        search: ((previous: Record<string, unknown>) => ({
          ...previous,
          branch: keptBranchId
        })) as never,
        hash: true,
        replace: true,
        resetScroll: false,
        hashScrollIntoView: false,
        ignoreBlocker: true
      });
      return;
    }
    const defaultId = defaultBranchOf(branches)?.id;
    shownDefault.current = defaultId
      ? { projectId, branchId: defaultId }
      : null;
  }, [
    branches,
    keptBranchId,
    location.pathname,
    navigate,
    projectId,
    requestedBranchId
  ]);
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
    if (namingBranch.current) {
      namingBranch.current = false;
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (location.hash) return;
      document
        .querySelector<HTMLElement>("[data-slot='top-toolbar-page']")
        ?.focus();
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
  const branch = resolveBranch(branches, requestedBranchId ?? keptBranchId);
  if (!branch)
    return (
      <BranchUnavailable
        projectName={project.project.name}
        onShowDefault={() =>
          void navigate({
            to: "/projects/$projectId/overview",
            params: { projectId },
            search: { branch: undefined }
          })
        }
      />
    );
  // Another project's pages never carry this project's branch.
  const navigateToProject = (id: string) =>
    navigate({
      to: "/projects/$projectId/overview",
      params: { projectId: id },
      search: { branch: undefined }
    });
  const navigateToRoute = (
    destination: NavigationDestination,
    id = project.project.id
  ) =>
    navigate({
      to: `/projects/${id}/${destination}` as never,
      ...(id === project.project.id
        ? {}
        : { search: { branch: undefined } as never })
    });
  return (
    <ProjectBranchScope context={project} branches={branches} branch={branch}>
      <AppShell
        api={api}
        catalog={catalog}
        activeProjectId={project.project.id}
        activeRoute={route}
        navigateToProject={navigateToProject}
        navigateToRoute={navigateToRoute}
        navigateToOrganization={(organizationId, page) =>
          navigate(
            page === "projects"
              ? {
                  to: "/organizations/$organizationId",
                  params: { organizationId }
                }
              : {
                  to: `/organizations/$organizationId/${page}`,
                  params: { organizationId }
                }
          )
        }
        openPreferences={() => navigate({ to: "/profile" as never })}
        signOut={() => router.options.context.auth.signOut()}
        profile={profileQuery.data}
        retryCatalog={() => reloadHierarchy(router)}
      >
        <Outlet />
      </AppShell>
    </ProjectBranchScope>
  );
}
