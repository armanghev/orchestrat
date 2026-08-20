import { useState } from "react";
import type { Project } from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDeleteDialog } from "./confirm-delete-dialog";
import type { ProjectContext } from "@/features/hierarchy/catalog";
import type { ApiClient } from "@/lib/api/client";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Request failed.";

export function ProjectSettingsPage({ context, api, onUpdated, onDeleted }: { context: ProjectContext; api: ApiClient; onUpdated: (project: Project) => void; onDeleted: () => void }) {
  const { organization, project } = context;
  const canEdit = organization.role !== "member";
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
  const changed = name !== project.name || slug !== project.slug || description !== (project.description ?? "");
  const valid = name.trim().length > 0 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);

  async function save() {
    if (!canEdit || !changed || !valid) return;
    setSaving(true); setError(null); setSaveStatus(null);
    try { onUpdated(await api.updateProject(project.id, { name: name.trim(), slug, description: description.trim() || null })); setSaveStatus("Project saved."); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  async function toggleArchive() {
    setLifecyclePending(true); setError(null);
    try { onUpdated(project.status === "active" ? await api.archiveProject(project.id) : await api.reactivateProject(project.id)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setLifecyclePending(false); }
  }
  async function removeProject() {
    setDeletePending(true); setDeleteError(null);
    try { await api.deleteProject(project.id, project.name); onDeleted(); }
    catch (cause) { setDeleteError(errorMessage(cause)); }
    finally { setDeletePending(false); }
  }

  return <section className="mx-auto w-full max-w-4xl space-y-8 p-6 md:p-8" aria-labelledby="project-settings-heading">
    <header><h1 id="project-settings-heading" tabIndex={-1} className="text-2xl font-semibold tracking-tight">Project settings</h1><p className="mt-2 text-sm text-muted-foreground">Manage project details, lifecycle, and technical metadata.</p></header>
    <section className="space-y-5 border-y py-6" aria-labelledby="project-general-heading"><div><h2 id="project-general-heading" className="font-medium">General</h2><p className="mt-1 text-sm text-muted-foreground">These details identify the project across the dashboard.</p></div><div className="space-y-4"><div className="space-y-2"><Label htmlFor="project-name">Name</Label><Input id="project-name" value={name} disabled={!canEdit || saving} onChange={(event) => setName(event.target.value)} /></div><div className="space-y-2"><Label htmlFor="project-slug">Slug</Label><Input id="project-slug" value={slug} disabled={!canEdit || saving} onChange={(event) => setSlug(event.target.value.toLowerCase())} /></div><div className="space-y-2"><Label htmlFor="project-description">Description</Label><textarea id="project-description" value={description} disabled={!canEdit || saving} onChange={(event) => setDescription(event.target.value)} rows={4} maxLength={4000} className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50" /></div></div>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{saveStatus ? <p role="status" className="text-sm text-muted-foreground">{saveStatus}</p> : null}{canEdit ? <Button disabled={!changed || !valid || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</Button> : <p className="text-sm text-muted-foreground">You have read-only access to project settings.</p>}</section>
    <section className="space-y-5 border-b pb-8" aria-labelledby="project-technical-heading"><div><h2 id="project-technical-heading" className="font-medium">Technical details</h2></div><dl className="grid gap-4 sm:grid-cols-2"><div><dt className="text-xs uppercase tracking-wide text-muted-foreground">Project ID</dt><dd className="mt-1 break-all font-mono text-sm">{project.id}</dd></div><div><dt className="text-xs uppercase tracking-wide text-muted-foreground">Organization</dt><dd className="mt-1 text-sm">{organization.name}</dd></div><div><dt className="text-xs uppercase tracking-wide text-muted-foreground">Status</dt><dd className="mt-1 capitalize text-sm">{project.status}</dd></div><div><dt className="text-xs uppercase tracking-wide text-muted-foreground">Created</dt><dd className="mt-1 text-sm">{new Date(project.created_at).toLocaleDateString()}</dd></div></dl></section>
    {canEdit ? <section className="space-y-5 border-b pb-8" aria-labelledby="project-lifecycle-heading"><div><h2 id="project-lifecycle-heading" className="font-medium">Lifecycle</h2><p className="mt-1 text-sm text-muted-foreground">Archived projects are retained but unavailable for normal work.</p></div><Button variant="outline" disabled={lifecyclePending} onClick={() => void toggleArchive()}>{lifecyclePending ? "Updating…" : project.status === "active" ? "Archive project" : "Reactivate project"}</Button></section> : null}
    {organization.role === "owner" ? <section className="space-y-4 border border-destructive/40 p-5" aria-labelledby="project-danger-heading"><div><h2 id="project-danger-heading" className="font-medium text-destructive">Danger zone</h2><p className="mt-1 text-sm text-muted-foreground">Permanently delete this project and its data.</p></div><Button variant="destructive" onClick={() => { setDeleteError(null); setDeleteOpen(true); }}>Delete project</Button></section> : null}
    <ConfirmDeleteDialog open={deleteOpen} onOpenChange={setDeleteOpen} entityLabel="project" entityName={project.name} description="This permanently deletes the project and all associated data. This cannot be undone." pending={deletePending} error={deleteError} onConfirm={removeProject} />
  </section>;
}
