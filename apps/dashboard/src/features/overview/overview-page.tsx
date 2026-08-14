import { Archive } from "lucide-react";
import type { ProjectContext } from "@/features/hierarchy/catalog";

export function OverviewPage({ context }: { context: ProjectContext }) {
  const { organization, workspace, project } = context;
  const archived = project.status === "archived";
  return <section className="mx-auto w-full max-w-5xl p-6 md:p-8" aria-labelledby="overview-heading">
    <h1 id="overview-heading" tabIndex={-1} className="text-2xl font-semibold tracking-tight">Overview</h1>
    <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{project.description || "No project description has been added."}</p>
    <div className="mt-8 grid divide-y border-y md:grid-cols-2 md:divide-x md:divide-y-0">
      <dl className="space-y-5 p-5 md:p-6">
        <div><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Organization</dt><dd className="mt-1 text-sm">{organization.name}</dd></div>
        <div><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Access</dt><dd className="mt-1 text-sm capitalize">{organization.role}</dd></div>
        <div><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Workspace</dt><dd className="mt-1 text-sm">{workspace.name}</dd></div>
      </dl>
      <dl className="space-y-5 p-5 md:p-6">
        <div><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Project slug</dt><dd className="mt-1 font-mono text-sm">{project.slug}</dd></div>
        <div><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</dt><dd className="mt-1 flex items-center gap-2 text-sm capitalize">{archived ? <Archive aria-hidden="true" className="size-4" /> : null}{project.status}{archived ? <span className="text-muted-foreground">(archived)</span> : null}</dd></div>
        <div><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Project ID</dt><dd className="mt-1 break-all font-mono text-sm">{project.id}</dd></div>
      </dl>
    </div>
  </section>;
}
