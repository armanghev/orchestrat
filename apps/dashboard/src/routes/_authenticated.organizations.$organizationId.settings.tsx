import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { organizationsQueryOptions, hierarchyKeys } from "@/features/hierarchy/query-options";
import { AuthenticatedSettingsShell } from "@/features/settings/authenticated-settings-shell";
import { OrganizationSettingsPage } from "@/features/settings/organization-settings-page";

function OrganizationSettingsRoute() {
  const { organizationId } = Route.useParams();
  const router = useRouter();
  const navigate = useNavigate();
  const { api, queryClient } = router.options.context;
  const organizationsQuery = useQuery(organizationsQueryOptions(api));
  const profileQuery = useQuery({
    queryKey: ["profile"],
    queryFn: () => api.getProfile()
  });

  if (organizationsQuery.isPending || profileQuery.isPending)
    return <div className="h-dvh animate-pulse bg-background" aria-label="Loading organization settings" />;

  const organization = organizationsQuery.data?.organizations.find(
    (item) => item.id === organizationId
  );
  if (!organization || profileQuery.isError)
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Organization unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We couldn’t load these organization settings.
        </p>
      </main>
    );

  const leaveSettings = async () => {
    await queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
    await navigate({ to: "/" });
  };

  return (
    <AuthenticatedSettingsShell>
      <OrganizationSettingsPage
        organization={organization}
        api={api}
        currentUserId={profileQuery.data.user_id}
        onUpdated={() => {
          void queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
        }}
        onDeleted={() => void leaveSettings()}
        onLeft={() => void leaveSettings()}
      />
    </AuthenticatedSettingsShell>
  );
}

export const Route = createFileRoute(
  "/_authenticated/organizations/$organizationId/settings"
)({ component: OrganizationSettingsRoute });
