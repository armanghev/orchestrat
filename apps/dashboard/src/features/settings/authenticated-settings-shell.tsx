import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell/app-shell";
import type { NavigationDestination } from "@/features/command/commands";
import {
  hierarchyKeys,
  projectCatalogQueryOptions
} from "@/features/hierarchy/query-options";
import { Button } from "@/components/ui/button";

export function AuthenticatedSettingsShell({
  children,
  activeProjectId
}: {
  children: ReactNode;
  activeProjectId?: string;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const { api, auth, queryClient } = router.options.context;
  const catalogQuery = useQuery(projectCatalogQueryOptions(api));
  const profileQuery = useQuery({
    queryKey: ["profile"],
    queryFn: () => api.getProfile()
  });

  if (catalogQuery.isPending)
    return <div className="h-dvh animate-pulse bg-background" aria-label="Loading settings" />;

  if (catalogQuery.isError)
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Settings unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We couldn’t load your project catalog.
        </p>
        <Button className="mt-6 w-fit" onClick={() => void catalogQuery.refetch()}>
          Retry
        </Button>
      </main>
    );

  const catalog = catalogQuery.data;
  const selectedProjectId =
    activeProjectId ?? catalog.projects[0]?.project.id;
  const navigateToProject = (projectId: string) =>
    navigate({
      to: "/projects/$projectId/overview",
      params: { projectId }
    });
  const navigateToRoute = async (
    destination: NavigationDestination,
    projectId = selectedProjectId
  ) => {
    if (!projectId) {
      await navigate({ to: "/setup" });
      return;
    }
    await navigate({ to: `/projects/${projectId}/${destination}` as never });
  };

  return (
    <AppShell
      catalog={catalog}
      activeProjectId={selectedProjectId}
      activeRoute="settings"
      navigateToProject={navigateToProject}
      navigateToRoute={navigateToRoute}
      openPreferences={() => navigate({ to: "/profile" as never })}
      signOut={() => auth.signOut()}
      profile={profileQuery.data}
      retryCatalog={async () => {
        await queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
        await catalogQuery.refetch();
      }}
    >
      {children}
    </AppShell>
  );
}
