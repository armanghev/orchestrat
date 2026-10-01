import { useState } from "react";
import type { Project } from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/dashboard/page";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDeleteDialog } from "./confirm-delete-dialog";
import { LocalIntegrationStatusSection } from "./local-integration-status";
import { ProjectMembersSection } from "./project-members-section";
import { BranchesSettingsSection } from "@/features/branches/branches-settings-section";
import type { ProjectContext } from "@/features/hierarchy/catalog";
import type { ApiClient } from "@/lib/api/client";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

export function ProjectSettingsPage({
  context,
  api,
  onUpdated,
  onDeleted,
  onMembershipChanged
}: {
  context: ProjectContext;
  api: ApiClient;
  onUpdated: (project: Project) => void;
  onDeleted: () => void;
  onMembershipChanged: () => Promise<void> | void;
}) {
  const { organization, project } = context;
  const canEdit = project.role === "owner" || project.role === "admin";
  const [name, setName] = useState(project.name);
  const [slug, setSlug] = useState(project.slug);
  const [description, setDescription] = useState(project.description ?? "");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const changed =
    name !== project.name ||
    slug !== project.slug ||
    description !== (project.description ?? "");
  const valid =
    name.trim().length > 0 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);

  async function save() {
    if (!canEdit || !changed || !valid) return;
    setSaving(true);
    setError(null);
    setSaveStatus(null);
    try {
      onUpdated(
        await api.updateProject(project.id, {
          name: name.trim(),
          slug,
          description: description.trim() || null
        })
      );
      setSaveStatus("Project saved.");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  async function toggleArchive() {
    setLifecyclePending(true);
    setError(null);
    try {
      onUpdated(
        project.status === "active"
          ? await api.archiveProject(project.id)
          : await api.reactivateProject(project.id)
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLifecyclePending(false);
    }
  }
  async function removeProject() {
    setDeletePending(true);
    setDeleteError(null);
    try {
      await api.deleteProject(project.id, project.name);
      onDeleted();
    } catch (cause) {
      setDeleteError(errorMessage(cause));
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <section className="dashboard-page" aria-label="Project settings">
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>General</h2>
            </CardTitle>
            <CardDescription>
              These details identify the project across your workspace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="project-name">Name</FieldLabel>
                <Input
                  id="project-name"
                  value={name}
                  disabled={!canEdit || saving}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="project-slug">Slug</FieldLabel>
                <Input
                  id="project-slug"
                  value={slug}
                  disabled={!canEdit || saving}
                  onChange={(event) =>
                    setSlug(event.target.value.toLowerCase())
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="project-description">
                  Description
                </FieldLabel>
                <Textarea
                  id="project-description"
                  value={description}
                  disabled={!canEdit || saving}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={4}
                  maxLength={4000}
                />
              </Field>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {saveStatus ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {saveStatus}
                </p>
              ) : null}
            </FieldGroup>
          </CardContent>
          <CardFooter className="justify-end">
            {canEdit ? (
              <Button
                disabled={!changed || !valid || saving}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save changes"}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                You have read-only access to project settings.
              </p>
            )}
          </CardFooter>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Technical details</h2>
            </CardTitle>
            <CardDescription>Your project at a glance.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-5 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Project ID</dt>
                <dd className="mt-1.5 break-all font-mono text-xs">
                  {project.id}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Organization</dt>
                <dd className="mt-1.5">{organization.name}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Status</dt>
                <dd className="mt-1.5">
                  <StatusBadge status={project.status} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Created</dt>
                <dd className="mt-1.5">
                  {new Date(project.created_at).toLocaleDateString()}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>
      <BranchesSettingsSection api={api} projectId={project.id} />
      <ProjectMembersSection
        project={project}
        organization={organization}
        api={api}
        onMembershipChanged={onMembershipChanged}
      />
      <LocalIntegrationStatusSection projectId={project.id} />
      {canEdit ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Lifecycle</h2>
            </CardTitle>
            <CardDescription>
              Archived projects are retained but unavailable for normal work.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              disabled={lifecyclePending}
              onClick={() => void toggleArchive()}
            >
              {lifecyclePending
                ? "Updating…"
                : project.status === "active"
                  ? "Archive project"
                  : "Reactivate project"}
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {project.role === "owner" ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-destructive">Danger zone</h2>
            </CardTitle>
            <CardDescription>
              Permanently delete this project and its data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="destructive"
              onClick={() => {
                setDeleteError(null);
                setDeleteOpen(true);
              }}
            >
              Delete project
            </Button>
          </CardContent>
        </Card>
      ) : null}
      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        entityLabel="project"
        entityName={project.name}
        description="This permanently deletes the project and all associated data. This cannot be undone."
        pending={deletePending}
        error={deleteError}
        onConfirm={removeProject}
      />
    </section>
  );
}
