import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  useNavigate,
  useRouter
} from "@tanstack/react-router";
import { hierarchyKeys } from "@/features/hierarchy/query-options";
import { OrganizationMembersPage } from "@/features/settings/organization-members-page";
import { useOrganizationRoute } from "./_authenticated.organizations.$organizationId";

function OrganizationMembersRoute() {
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
        className="dashboard-page h-48 animate-pulse rounded bg-muted"
        aria-label="Loading members"
      />
    );
  if (profileQuery.isError)
    return (
      <p role="alert" className="dashboard-page text-sm text-muted-foreground">
        We couldn’t load the members.
      </p>
    );
  return (
    <OrganizationMembersPage
      organization={organization}
      api={api}
      currentUserId={profileQuery.data.user_id}
      onLeft={async () => {
        // Drop the cache rather than refetch it: this organization's queries
        // would now fail, and /setup must decide from a fresh catalog.
        queryClient.removeQueries({ queryKey: hierarchyKeys.all });
        await navigate({ to: "/setup" });
      }}
    />
  );
}

export const Route = createFileRoute(
  "/_authenticated/organizations/$organizationId/members"
)({ component: OrganizationMembersRoute });
