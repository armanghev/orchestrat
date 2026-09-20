import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent
} from "@/components/ui/card";
import {
  NativeSelect,
  NativeSelectOption
} from "@/components/ui/native-select";
import { Field, FieldGroup } from "@/components/ui/field";
import { useEffect, useState } from "react";
import type {
  Organization,
  OrganizationMember,
  OrganizationRole
} from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ApiClient } from "@/lib/api/client";
import { ConfirmDeleteDialog } from "./confirm-delete-dialog";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

export function OrganizationSettingsPage({
  organization,
  api,
  currentUserId,
  onUpdated,
  onDeleted,
  onLeft
}: {
  organization: Organization;
  api: ApiClient;
  currentUserId: string;
  onUpdated: (organization: Organization) => void;
  onDeleted: () => void;
  onLeft: () => void;
}) {
  const canEdit = organization.role !== "member";
  const [name, setName] = useState(organization.name);
  const [slug, setSlug] = useState(organization.slug);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberPending, setMemberPending] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const changed = name !== organization.name || slug !== organization.slug;
  const valid =
    name.trim().length > 0 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);

  useEffect(() => {
    let active = true;
    setMembersLoading(true);
    setMembersError(null);
    void api
      .listOrganizationMembers(organization.id)
      .then(
        (result) => {
          if (active) setMembers(result.members);
        },
        (error) => {
          if (active) setMembersError(errorMessage(error));
        }
      )
      .finally(() => {
        if (active) setMembersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, organization.id]);

  async function save() {
    if (!canEdit || !changed || !valid) return;
    setSaving(true);
    setSaveError(null);
    setSaveStatus(null);
    try {
      onUpdated(
        await api.updateOrganization(organization.id, {
          name: name.trim(),
          slug
        })
      );
      setSaveStatus("Organization saved.");
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function changeRole(
    member: OrganizationMember,
    role: OrganizationRole
  ) {
    const manageable =
      organization.role === "owner" ||
      (organization.role === "admin" && member.role !== "owner");
    if (!manageable || member.role === role) return;
    setMemberPending(member.user_id);
    setMemberError(null);
    try {
      const updated = await api.updateOrganizationMember(
        organization.id,
        member.user_id,
        role
      );
      setMembers((current) =>
        current.map((item) =>
          item.user_id === updated.user_id ? updated : item
        )
      );
    } catch (error) {
      setMemberError(errorMessage(error));
    } finally {
      setMemberPending(null);
    }
  }

  async function removeMember(member: OrganizationMember) {
    const manageable =
      organization.role === "owner" ||
      (organization.role === "admin" && member.role !== "owner");
    if (!manageable) return;
    setMemberPending(member.user_id);
    setMemberError(null);
    try {
      await api.removeOrganizationMember(organization.id, member.user_id);
      setMembers((current) =>
        current.filter((item) => item.user_id !== member.user_id)
      );
    } catch (error) {
      setMemberError(errorMessage(error));
    } finally {
      setMemberPending(null);
    }
  }

  async function leave() {
    setLeaving(true);
    setMemberError(null);
    try {
      await api.leaveOrganization(organization.id);
      onLeft();
    } catch (error) {
      setMemberError(errorMessage(error));
    } finally {
      setLeaving(false);
    }
  }

  async function removeOrganization() {
    setDeletePending(true);
    setDeleteError(null);
    try {
      await api.deleteOrganization(organization.id, organization.name);
      onDeleted();
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <section
      className="dashboard-page max-w-5xl"
      aria-labelledby="organization-settings-heading"
    >
      <header>
        <h1
          id="organization-settings-heading"
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight"
        >
          Organization settings
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Manage this organization and its members.
        </p>
      </header>
      <Card aria-labelledby="organization-general-heading">
        <CardHeader>
          <CardTitle>
            <h2 id="organization-general-heading" className="font-medium">
              General
            </h2>
          </CardTitle>
          <CardDescription>
            These details identify the organization across the dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-5">
          <FieldGroup className="grid gap-4 sm:grid-cols-2">
            <Field>
              <Label htmlFor="organization-name">Name</Label>
              <Input
                id="organization-name"
                value={name}
                disabled={!canEdit || saving}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <Label htmlFor="organization-slug">Slug</Label>
              <Input
                id="organization-slug"
                value={slug}
                disabled={!canEdit || saving}
                onChange={(event) => setSlug(event.target.value.toLowerCase())}
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers, and hyphens.
              </p>
            </Field>
          </FieldGroup>
          {saveError ? (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          ) : null}
          {saveStatus ? (
            <p role="status" className="text-sm text-muted-foreground">
              {saveStatus}
            </p>
          ) : null}
          {canEdit ? (
            <Button
              disabled={!changed || !valid || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              You have read-only access to organization settings.
            </p>
          )}
        </CardContent>
      </Card>
      <Card aria-labelledby="organization-members-heading">
        <CardHeader>
          <CardTitle>
            <h2 id="organization-members-heading" className="font-medium">
              Members
            </h2>
          </CardTitle>
          <CardDescription>
            Manage access for people who belong to this organization.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-5">
          {membersLoading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading members…
            </p>
          ) : membersError ? (
            <p role="alert" className="text-sm text-destructive">
              {membersError}
            </p>
          ) : (
            <div className="divide-y rounded-lg border">
              {members.map((member) => {
                const manageable =
                  organization.role === "owner" ||
                  (organization.role === "admin" && member.role !== "owner");
                return (
                  <div
                    key={member.user_id}
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {member.full_name || member.username || member.email}
                        {member.user_id === currentUserId ? " (you)" : ""}
                      </p>
                      <p className="truncate text-sm text-muted-foreground">
                        {member.email}
                        {member.username ? ` · @${member.username}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <NativeSelect
                        aria-label={`Role for ${member.email}`}
                        value={member.role}
                        disabled={
                          !manageable || memberPending === member.user_id
                        }
                        onChange={(event) =>
                          void changeRole(
                            member,
                            event.target.value as OrganizationRole
                          )
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
                      {manageable ? (
                        <Button
                          variant="ghost"
                          disabled={memberPending === member.user_id}
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
          )}
          {memberError ? (
            <p role="alert" className="text-sm text-destructive">
              {memberError}
            </p>
          ) : null}
          {members.some((member) => member.user_id === currentUserId) ? (
            <Button
              variant="outline"
              disabled={leaving}
              onClick={() => void leave()}
            >
              {leaving ? "Leaving…" : "Leave organization"}
            </Button>
          ) : null}
        </CardContent>
      </Card>
      {organization.role === "owner" ? (
        <Card aria-labelledby="organization-danger-heading">
          <CardHeader>
            <CardTitle>
              <h2
                id="organization-danger-heading"
                className="font-medium text-destructive"
              >
                Danger zone
              </h2>
            </CardTitle>
            <CardDescription>
              Deleting this organization permanently deletes all of its projects
              and data.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-5">
            <Button
              variant="destructive"
              onClick={() => {
                setDeleteError(null);
                setDeleteOpen(true);
              }}
            >
              Delete organization
            </Button>
          </CardContent>
        </Card>
      ) : null}
      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        entityLabel="organization"
        entityName={organization.name}
        description="This permanently deletes the organization, all projects, and all associated data. This cannot be undone."
        pending={deletePending}
        error={deleteError}
        onConfirm={removeOrganization}
      />
    </section>
  );
}
