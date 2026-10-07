import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { organizationMembersQueryOptions } from "@/features/hierarchy/query-options";
import { useOrganizationRoute } from "./_authenticated.organizations.$organizationId";

// ponytail: a read-only list; ORC-52 moves member management here from
// organization settings.
function OrganizationMembers() {
  const { organization } = useOrganizationRoute();
  const { api } = useRouter().options.context;
  const members = useQuery(
    organizationMembersQueryOptions(api, organization.id)
  );
  return (
    <section
      className="dashboard-page max-w-3xl"
      aria-label="Organization members"
    >
      {members.isPending ? (
        <div aria-label="Loading members" className="space-y-2">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="h-12 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : members.isError ? (
        <div role="alert" className="flex items-center gap-3 text-sm">
          We couldn’t load the members.
          <Button
            variant="outline"
            size="sm"
            onClick={() => void members.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (
        <>
          <ul className="divide-y rounded-xl ring-1 ring-border">
            {members.data.members.map((member) => (
              <li
                key={member.user_id}
                className="flex items-center gap-3 px-4 py-3"
              >
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-sm font-medium">
                    {member.full_name || member.username || member.email}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {member.email}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground capitalize">
                  {member.role}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-muted-foreground">
            Change roles or remove members in{" "}
            <Link
              to="/organizations/$organizationId/settings"
              params={{ organizationId: organization.id }}
              className="font-medium text-foreground underline"
            >
              organization settings
            </Link>
            .
          </p>
        </>
      )}
    </section>
  );
}

export const Route = createFileRoute(
  "/_authenticated/organizations/$organizationId/members"
)({ component: OrganizationMembers });
