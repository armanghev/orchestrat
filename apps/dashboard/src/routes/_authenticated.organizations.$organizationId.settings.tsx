import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  useNavigate,
  useRouter
} from "@tanstack/react-router";
import { hierarchyKeys } from "@/features/hierarchy/query-options";
import { OrganizationSettingsPage } from "@/features/settings/organization-settings-page";
import { useOrganizationRoute } from "./_authenticated.organizations.$organizationId";

function OrganizationSettingsRoute() {
  const { organization } = useOrganizationRoute();
  const router = useRouter();
  const navigate = useNavigate();
  const { api, queryClient } = router.options.context;
  const profileQuery = useQuery({
    queryKey: ["profile"],
    queryFn: () => api.getProfile()
  });

  if (profileQuery.isPending)
    return (
      <div
        className="dashboard-page h-64 animate-pulse rounded bg-muted"
        aria-label="Loading organization settings"
      />
    );
  if (profileQuery.isError)
    return (
      <p role="alert" className="dashboard-page text-sm text-muted-foreground">
        We couldn’t load these organization settings.
      </p>
    );

  const leaveOrganization = async () => {
    await queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
    await navigate({ to: "/setup" });
  };

  return (
    <OrganizationSettingsPage
      organization={organization}
      api={api}
      onUpdated={() => {
        void queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
      }}
      onDeleted={() => void leaveOrganization()}
    />
  );
}

export const Route = createFileRoute(
  "/_authenticated/organizations/$organizationId/settings"
)({ component: OrganizationSettingsRoute });
