import { useEffect, useMemo, useState } from "react";
import type {
  Organization,
  OrganizationMember,
  Project,
  ProjectInvitation,
  ProjectMember
} from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption
} from "@/components/ui/native-select";
import type { ApiClient } from "@/lib/api/client";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

function memberName(member: OrganizationMember | ProjectMember) {
  return member.full_name || member.username || member.email;
}

// Invite links point at this dashboard. The desktop webview has no web
// origin to share, so it can't make them (the desktop app returns in v1.1).
function publicInvitationUrl(token: string): string | null {
  const origin = window.location.origin;
  if (!/^https?:\/\//u.test(origin)) return null;
  try {
    const url = new URL("/project-invitations/join", origin);
    url.hash = new URLSearchParams({ token }).toString();
    return url.toString();
  } catch {
    return null;
  }
}

function invitationState(invitation: ProjectInvitation) {
  if (invitation.revoked_at) return "Revoked";
  if (invitation.accepted_at) return "Accepted";
  if (new Date(invitation.expires_at).getTime() <= Date.now()) return "Expired";
  return "Active";
}

export function ProjectMembersSection({
  project,
  organization,
  api,
  onMembershipChanged
}: {
  project: Project;
  organization: Organization;
  api: ApiClient;
  onMembershipChanged?: () => Promise<void> | void;
}) {
  const canEdit = project.role === "owner" || project.role === "admin";
  const [organizationMembers, setOrganizationMembers] = useState<
    OrganizationMember[]
  >([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [pendingMemberId, setPendingMemberId] = useState<string | null>(null);
  const [pendingInvitationId, setPendingInvitationId] = useState<string | null>(
    null
  );
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRole, setSelectedRole] =
    useState<ProjectMember["role"]>("member");
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const memberIds = new Set(members.map((member) => member.user_id));
    return organizationMembers.filter(
      (member) => !memberIds.has(member.user_id)
    );
  }, [members, organizationMembers]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void Promise.all([
      api.listOrganizationMembers(organization.id),
      api.listProjectMembers(project.id),
      canEdit ? api.listProjectInvitations(project.id) : Promise.resolve(null)
    ])
      .then(([organizationResult, projectResult, invitationResult]) => {
        if (!active) return;
        setOrganizationMembers(organizationResult.members);
        setMembers(projectResult.members);
        setInvitations(invitationResult?.invitations ?? []);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, canEdit, organization.id, project.id]);

  function canManage(member: ProjectMember) {
    return (
      project.role === "owner" ||
      (project.role === "admin" && member.role !== "owner")
    );
  }

  async function addMember() {
    if (!canEdit || !selectedUserId) return;
    setPendingMemberId(selectedUserId);
    setMemberError(null);
    try {
      const member = await api.addProjectMember(project.id, {
        user_id: selectedUserId,
        role: selectedRole
      });
      setMembers((current) => [...current, member]);
      setSelectedUserId("");
      setSelectedRole("member");
      await onMembershipChanged?.();
    } catch (error) {
      setMemberError(errorMessage(error));
    } finally {
      setPendingMemberId(null);
    }
  }

  async function changeRole(
    member: ProjectMember,
    role: ProjectMember["role"]
  ) {
    if (!canManage(member) || member.role === role) return;
    setPendingMemberId(member.user_id);
    setMemberError(null);
    try {
      const updated = await api.updateProjectMember(
        project.id,
        member.user_id,
        role
      );
      setMembers((current) =>
        current.map((item) =>
          item.user_id === updated.user_id ? updated : item
        )
      );
      await onMembershipChanged?.();
    } catch (error) {
      setMemberError(errorMessage(error));
    } finally {
      setPendingMemberId(null);
    }
  }

  async function removeMember(member: ProjectMember) {
    if (!canManage(member)) return;
    setPendingMemberId(member.user_id);
    setMemberError(null);
    try {
      await api.removeProjectMember(project.id, member.user_id);
      setMembers((current) =>
        current.filter((item) => item.user_id !== member.user_id)
      );
      await onMembershipChanged?.();
    } catch (error) {
      setMemberError(errorMessage(error));
    } finally {
      setPendingMemberId(null);
    }
  }

  async function createInvitation() {
    if (!canEdit) return;
    if (!publicInvitationUrl("a".repeat(43))) {
      setInvitationError("The public dashboard URL is not configured.");
      return;
    }
    setPendingInvitationId("new");
    setInvitationError(null);
    setCopyStatus(null);
    try {
      const result = await api.createProjectInvitation(project.id);
      const link = publicInvitationUrl(result.token);
      if (!link) throw new Error("Unable to create a public invitation link.");
      setCreatedLink(link);
      setInvitations((current) => [...current, result.invitation]);
    } catch (error) {
      setInvitationError(errorMessage(error));
    } finally {
      setPendingInvitationId(null);
    }
  }

  async function copyInvitation() {
    if (!createdLink) return;
    setCopyStatus(null);
    try {
      await navigator.clipboard.writeText(createdLink);
      setCopyStatus("Invitation link copied.");
    } catch {
      setCopyStatus("Copy the invitation link from the field above.");
    }
  }

  async function revokeInvitation(invitation: ProjectInvitation) {
    if (!canEdit) return;
    setPendingInvitationId(invitation.id);
    setInvitationError(null);
    try {
      const { invitation: revoked } = await api.revokeProjectInvitation(
        project.id,
        invitation.id
      );
      setInvitations((current) =>
        current.map((item) => (item.id === revoked.id ? revoked : item))
      );
    } catch (error) {
      setInvitationError(errorMessage(error));
    } finally {
      setPendingInvitationId(null);
    }
  }

  return (
    <Card aria-labelledby="project-members-heading">
      <CardHeader>
        <CardTitle>
          <h2 id="project-members-heading">Project members</h2>
        </CardTitle>
        <CardDescription>
          Choose which organization members can access this project.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading project members…
          </p>
        ) : loadError ? (
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        ) : (
          <>
            <div className="divide-y rounded-lg border">
              {members.map((member) => {
                const manageable = canManage(member);
                return (
                  <div
                    key={member.user_id}
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {memberName(member)}
                      </p>
                      <p className="truncate text-sm text-muted-foreground">
                        {member.email}
                        {member.username ? ` · @${member.username}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <NativeSelect
                        aria-label={`Role for ${member.email}`}
                        value={member.role}
                        disabled={
                          !manageable || pendingMemberId === member.user_id
                        }
                        onChange={(event) =>
                          void changeRole(
                            member,
                            event.target.value as ProjectMember["role"]
                          )
                        }
                      >
                        {project.role === "owner" || member.role === "owner" ? (
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
                      {manageable ? (
                        <Button
                          variant="ghost"
                          disabled={pendingMemberId === member.user_id}
                          onClick={() => void removeMember(member)}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
            {memberError ? (
              <p role="alert" className="text-sm text-destructive">
                {memberError}
              </p>
            ) : null}
            {canEdit ? (
              <FieldGroup className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
                <Field>
                  <FieldLabel htmlFor="project-member">Add member</FieldLabel>
                  <NativeSelect
                    id="project-member"
                    aria-label="Organization member"
                    value={selectedUserId}
                    disabled={
                      pendingMemberId !== null || candidates.length === 0
                    }
                    onChange={(event) => setSelectedUserId(event.target.value)}
                  >
                    <NativeSelectOption value="">
                      {candidates.length === 0
                        ? "Every organization member has access"
                        : "Choose an organization member"}
                    </NativeSelectOption>
                    {candidates.map((member) => (
                      <NativeSelectOption
                        key={member.user_id}
                        value={member.user_id}
                      >
                        {memberName(member)} ({member.email})
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor="project-member-role">Role</FieldLabel>
                  <NativeSelect
                    id="project-member-role"
                    value={selectedRole}
                    disabled={pendingMemberId !== null}
                    onChange={(event) =>
                      setSelectedRole(
                        event.target.value as ProjectMember["role"]
                      )
                    }
                  >
                    {project.role === "owner" ? (
                      <NativeSelectOption value="owner">
                        Owner
                      </NativeSelectOption>
                    ) : null}
                    <NativeSelectOption value="admin">Admin</NativeSelectOption>
                    <NativeSelectOption value="member">
                      Member
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Button
                  disabled={!selectedUserId || pendingMemberId !== null}
                  onClick={() => void addMember()}
                >
                  {pendingMemberId === selectedUserId ? "Adding…" : "Add"}
                </Button>
              </FieldGroup>
            ) : (
              <p className="text-sm text-muted-foreground">
                You can view this project roster, but only project owners and
                admins can manage it.
              </p>
            )}
          </>
        )}

        {canEdit ? (
          <div className="border-t pt-5">
            <h3 className="font-medium">Invitation links</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Links can be used once and expire after seven days.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <Button
                variant="outline"
                disabled={pendingInvitationId !== null}
                onClick={() => void createInvitation()}
              >
                {pendingInvitationId === "new"
                  ? "Creating…"
                  : "Create invitation link"}
              </Button>
            </div>
            {createdLink ? (
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <Input
                  aria-label="Invitation link"
                  readOnly
                  value={createdLink}
                />
                <Button variant="outline" onClick={() => void copyInvitation()}>
                  Copy link
                </Button>
              </div>
            ) : null}
            {copyStatus ? (
              <p role="status" className="mt-2 text-sm text-muted-foreground">
                {copyStatus}
              </p>
            ) : null}
            {invitationError ? (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {invitationError}
              </p>
            ) : null}
            {invitations.length > 0 ? (
              <div className="mt-4 divide-y rounded-lg border">
                {invitations.map((invitation) => {
                  const state = invitationState(invitation);
                  const revocable = state === "Active";
                  return (
                    <div
                      key={invitation.id}
                      className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div>
                        <p className="font-medium">{state}</p>
                        <p className="text-sm text-muted-foreground">
                          Expires{" "}
                          {new Date(invitation.expires_at).toLocaleString()}
                        </p>
                      </div>
                      {revocable ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pendingInvitationId === invitation.id}
                          onClick={() => void revokeInvitation(invitation)}
                        >
                          {pendingInvitationId === invitation.id
                            ? "Revoking…"
                            : "Revoke"}
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
