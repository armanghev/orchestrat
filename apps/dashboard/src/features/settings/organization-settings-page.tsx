import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent
} from "@/components/ui/card";
import { Field, FieldGroup } from "@/components/ui/field";
import { useState } from "react";
import type { Organization } from "@orchestrat/protocol";
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
  onUpdated,
  onDeleted
}: {
  organization: Organization;
  api: ApiClient;
  onUpdated: (organization: Organization) => void;
  onDeleted: () => void;
}) {
  const canEdit = organization.role !== "member";
  const [name, setName] = useState(organization.name);
  const [slug, setSlug] = useState(organization.slug);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const changed = name !== organization.name || slug !== organization.slug;
  const valid =
    name.trim().length > 0 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);

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
      className="dashboard-page max-w-2xl"
      aria-label="Organization settings"
    >
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
          <FieldGroup className="grid gap-4">
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
