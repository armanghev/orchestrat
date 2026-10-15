import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Organization,
  OrganizationMember,
  OrganizationRole
} from "@orchestrat/protocol";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption
} from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import type { ApiClient } from "@/lib/api/client";
import {
  hierarchyKeys,
  organizationMembersQueryOptions
} from "@/features/hierarchy/query-options";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

const roleLabels: Record<OrganizationRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member"
};

/** Owners manage everyone; admins manage everyone but owners. */
export function canManageMember(
  viewerRole: OrganizationRole,
  member: OrganizationMember
) {
  return (
    viewerRole === "owner" ||
    (viewerRole === "admin" && member.role !== "owner")
  );
}

function memberName(member: OrganizationMember) {
  return member.full_name || member.username || member.email;
}

export function OrganizationMembersPage({
  organization,
  api,
  currentUserId,
  onLeft
}: {
  organization: Organization;
  api: ApiClient;
  currentUserId: string;
  onLeft: () => void;
}) {
  const queryClient = useQueryClient();
  const membersQuery = useQuery(
    organizationMembersQueryOptions(api, organization.id)
  );
  const [error, setError] = useState<string | null>(null);
  // Roles and member counts also show in the catalog and the org home.
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
  const changeRole = useMutation({
    mutationFn: ({
      member,
      role
    }: {
      member: OrganizationMember;
      role: OrganizationRole;
    }) => api.updateOrganizationMember(organization.id, member.user_id, role),
    onMutate: () => setError(null),
    onSuccess: () => refresh(),
    onError: (cause) => setError(errorMessage(cause))
  });
  const remove = useMutation({
    mutationFn: (member: OrganizationMember) =>
      api.removeOrganizationMember(organization.id, member.user_id),
    onMutate: () => setError(null),
    onSuccess: () => refresh(),
    onError: (cause) => setError(errorMessage(cause))
  });
  const leave = useMutation({
    mutationFn: () => api.leaveOrganization(organization.id),
    onMutate: () => setError(null),
    onSuccess: onLeft,
    onError: (cause) => setError(errorMessage(cause))
  });
  const pendingId = changeRole.isPending
    ? changeRole.variables?.member.user_id
    : remove.isPending
      ? remove.variables?.user_id
      : undefined;

  if (membersQuery.isPending)
    return (
      <section
        className="dashboard-page max-w-4xl"
        aria-label="Loading members"
      >
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-14 rounded-lg" />
        ))}
      </section>
    );
  if (membersQuery.isError)
    return (
      <section className="dashboard-page max-w-4xl">
        <div role="alert" className="flex items-center gap-3 text-sm">
          We couldn’t load the members.
          <Button
            variant="outline"
            size="sm"
            onClick={() => void membersQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      </section>
    );

  const members = membersQuery.data.members;
  const isMember = members.some((member) => member.user_id === currentUserId);
  return (
    <section
      className="dashboard-page max-w-4xl"
      aria-label={`${organization.name} members`}
    >
      <p className="text-sm text-muted-foreground">
        {members.length === 1 ? "1 member" : `${members.length} members`}.
        People join through a project’s invitation link.
      </p>
      <div className="overflow-x-auto rounded-xl ring-1 ring-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-36">Role</TableHead>
              <TableHead className="hidden w-32 sm:table-cell">
                Joined
              </TableHead>
              <TableHead className="w-24">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const self = member.user_id === currentUserId;
              // Your own access changes through Leave, not the role select.
              const manageable =
                !self && canManageMember(organization.role, member);
              const label = memberName(member);
              return (
                <TableRow key={member.user_id}>
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar className="size-8 shrink-0 rounded-full">
                        {member.avatar_url ? (
                          <AvatarImage src={member.avatar_url} alt="" />
                        ) : null}
                        <AvatarFallback>
                          {label.slice(0, 1).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="grid min-w-0">
                        <span className="truncate font-medium">
                          {label}
                          {self ? (
                            <span className="font-normal text-muted-foreground">
                              {" "}
                              (you)
                            </span>
                          ) : null}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {member.email}
                        </span>
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {manageable ? (
                      <NativeSelect
                        aria-label={`Role for ${member.email}`}
                        value={member.role}
                        disabled={pendingId === member.user_id}
                        onChange={(event) =>
                          changeRole.mutate({
                            member,
                            role: event.target.value as OrganizationRole
                          })
                        }
                      >
                        {organization.role === "owner" ? (
                          <NativeSelectOption value="owner">
                            Owner
                          </NativeSelectOption>
                        ) : null}
                        <NativeSelectOption value="admin">
                          Admin
                        </NativeSelectOption>
                        <NativeSelectOption value="member">
                          Member
                        </NativeSelectOption>
                      </NativeSelect>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {roleLabels[member.role]}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                    {new Date(member.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {manageable ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${label}`}
                        disabled={pendingId === member.user_id}
                        onClick={() => remove.mutate(member)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {isMember ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-6">
          <p className="text-sm text-muted-foreground">
            Leaving removes your access to every project in {organization.name}.
          </p>
          <Button
            variant="outline"
            disabled={leave.isPending}
            onClick={() => leave.mutate()}
          >
            {leave.isPending ? "Leaving…" : "Leave organization"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
