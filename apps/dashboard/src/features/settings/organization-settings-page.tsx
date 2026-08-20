import { useEffect, useState } from "react";
import type { Organization, OrganizationMember, OrganizationRole } from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ApiClient } from "@/lib/api/client";
import { ConfirmDeleteDialog } from "./confirm-delete-dialog";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Request failed.";

export function OrganizationSettingsPage({ organization, api, currentUserId, onUpdated, onDeleted, onLeft }: {
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
  const valid = name.trim().length > 0 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);

  useEffect(() => {
    let active = true;
    setMembersLoading(true);
    setMembersError(null);
    void api.listOrganizationMembers(organization.id).then((result) => {
      if (active) setMembers(result.members);
    }, (error) => {
      if (active) setMembersError(errorMessage(error));
    }).finally(() => {
      if (active) setMembersLoading(false);
    });
    return () => { active = false; };
  }, [api, organization.id]);

  async function save() {
    if (!canEdit || !changed || !valid) return;
    setSaving(true); setSaveError(null); setSaveStatus(null);
    try { onUpdated(await api.updateOrganization(organization.id, { name: name.trim(), slug })); setSaveStatus("Organization saved."); }
    catch (error) { setSaveError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  async function changeRole(member: OrganizationMember, role: OrganizationRole) {
    const manageable = organization.role === "owner" || (organization.role === "admin" && member.role !== "owner");
    if (!manageable || member.role === role) return;
    setMemberPending(member.user_id); setMemberError(null);
    try {
      const updated = await api.updateOrganizationMember(organization.id, member.user_id, role);
      setMembers((current) => current.map((item) => item.user_id === updated.user_id ? updated : item));
    } catch (error) { setMemberError(errorMessage(error)); }
    finally { setMemberPending(null); }
  }

  async function removeMember(member: OrganizationMember) {
    const manageable = organization.role === "owner" || (organization.role === "admin" && member.role !== "owner");
    if (!manageable) return;
    setMemberPending(member.user_id); setMemberError(null);
    try {
      await api.removeOrganizationMember(organization.id, member.user_id);
      setMembers((current) => current.filter((item) => item.user_id !== member.user_id));
    } catch (error) { setMemberError(errorMessage(error)); }
    finally { setMemberPending(null); }
  }

  async function leave() {
    setLeaving(true); setMemberError(null);
    try { await api.leaveOrganization(organization.id); onLeft(); }
    catch (error) { setMemberError(errorMessage(error)); }
    finally { setLeaving(false); }
  }

  async function removeOrganization() {
    setDeletePending(true); setDeleteError(null);
    try { await api.deleteOrganization(organization.id, organization.name); onDeleted(); }
    catch (error) { setDeleteError(errorMessage(error)); }
    finally { setDeletePending(false); }
  }

  return <section className="mx-auto w-full max-w-4xl space-y-8 p-6 md:p-8" aria-labelledby="organization-settings-heading">
    <header><h1 id="organization-settings-heading" tabIndex={-1} className="text-2xl font-semibold tracking-tight">Organization settings</h1><p className="mt-2 text-sm text-muted-foreground">Manage this organization and its members.</p></header>
    <section className="space-y-5 border-y py-6" aria-labelledby="organization-general-heading"><div><h2 id="organization-general-heading" className="font-medium">General</h2><p className="mt-1 text-sm text-muted-foreground">These details identify the organization across the dashboard.</p></div><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="organization-name">Name</Label><Input id="organization-name" value={name} disabled={!canEdit || saving} onChange={(event) => setName(event.target.value)} /></div><div className="space-y-2"><Label htmlFor="organization-slug">Slug</Label><Input id="organization-slug" value={slug} disabled={!canEdit || saving} onChange={(event) => setSlug(event.target.value.toLowerCase())} /><p className="text-xs text-muted-foreground">Lowercase letters, numbers, and hyphens.</p></div></div>{saveError ? <p role="alert" className="text-sm text-destructive">{saveError}</p> : null}{saveStatus ? <p role="status" className="text-sm text-muted-foreground">{saveStatus}</p> : null}{canEdit ? <Button disabled={!changed || !valid || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save changes"}</Button> : <p className="text-sm text-muted-foreground">You have read-only access to organization settings.</p>}</section>
    <section className="space-y-5 border-b pb-8" aria-labelledby="organization-members-heading"><div><h2 id="organization-members-heading" className="font-medium">Members</h2><p className="mt-1 text-sm text-muted-foreground">Manage access for people who belong to this organization.</p></div>{membersLoading ? <p role="status" className="text-sm text-muted-foreground">Loading members…</p> : membersError ? <p role="alert" className="text-sm text-destructive">{membersError}</p> : <div className="divide-y rounded-lg border">{members.map((member) => { const manageable = organization.role === "owner" || (organization.role === "admin" && member.role !== "owner"); return <div key={member.user_id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="truncate font-medium">{member.full_name || member.username || member.email}{member.user_id === currentUserId ? " (you)" : ""}</p><p className="truncate text-sm text-muted-foreground">{member.email}{member.username ? ` · @${member.username}` : ""}</p></div><div className="flex items-center gap-2"><select aria-label={`Role for ${member.email}`} value={member.role} disabled={!manageable || memberPending === member.user_id} onChange={(event) => void changeRole(member, event.target.value as OrganizationRole)} className="h-8 rounded-lg border border-input bg-background px-2 text-sm">{organization.role === "owner" ? <option value="owner">Owner</option> : null}<option value="admin">Admin</option><option value="member">Member</option></select>{manageable ? <Button variant="ghost" disabled={memberPending === member.user_id} onClick={() => void removeMember(member)}>Remove</Button> : null}</div></div>; })}</div>}{memberError ? <p role="alert" className="text-sm text-destructive">{memberError}</p> : null}{members.some((member) => member.user_id === currentUserId) ? <Button variant="outline" disabled={leaving} onClick={() => void leave()}>{leaving ? "Leaving…" : "Leave organization"}</Button> : null}</section>
    {organization.role === "owner" ? <section className="space-y-4 border border-destructive/40 p-5" aria-labelledby="organization-danger-heading"><div><h2 id="organization-danger-heading" className="font-medium text-destructive">Danger zone</h2><p className="mt-1 text-sm text-muted-foreground">Deleting this organization permanently deletes all of its projects and data.</p></div><Button variant="destructive" onClick={() => { setDeleteError(null); setDeleteOpen(true); }}>Delete organization</Button></section> : null}
    <ConfirmDeleteDialog open={deleteOpen} onOpenChange={setDeleteOpen} entityLabel="organization" entityName={organization.name} description="This permanently deletes the organization, all projects, and all associated data. This cannot be undone." pending={deletePending} error={deleteError} onConfirm={removeOrganization} />
  </section>;
}
