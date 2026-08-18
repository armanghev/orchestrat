import { Link } from "@tanstack/react-router";
import type { ProjectContext } from "@/features/hierarchy/catalog";

export function ProjectSettingsPage({ context }: { context: ProjectContext }) {
  const { organization, workspace, project } = context;
  return (
    <section
      className="mx-auto w-full max-w-3xl p-6 md:p-8"
      aria-labelledby="project-settings-heading"
    >
      <h1
        id="project-settings-heading"
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight"
      >
        Project Settings
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Project details are read-only in this build.
      </p>
      <dl className="mt-8 divide-y border-y">
        <div className="grid gap-1 py-4 sm:grid-cols-3">
          <dt className="text-sm text-muted-foreground">Project name</dt>
          <dd className="text-sm sm:col-span-2">{project.name}</dd>
        </div>
        <div className="grid gap-1 py-4 sm:grid-cols-3">
          <dt className="text-sm text-muted-foreground">Slug</dt>
          <dd className="font-mono text-sm sm:col-span-2">{project.slug}</dd>
        </div>
        <div className="grid gap-1 py-4 sm:grid-cols-3">
          <dt className="text-sm text-muted-foreground">Status</dt>
          <dd className="capitalize text-sm sm:col-span-2">{project.status}</dd>
        </div>
        <div className="grid gap-1 py-4 sm:grid-cols-3">
          <dt className="text-sm text-muted-foreground">Project ID</dt>
          <dd className="break-all font-mono text-sm sm:col-span-2">
            {project.id}
          </dd>
        </div>
        <div className="grid gap-1 py-4 sm:grid-cols-3">
          <dt className="text-sm text-muted-foreground">Workspace</dt>
          <dd className="text-sm sm:col-span-2">{workspace.name}</dd>
        </div>
        <div className="grid gap-1 py-4 sm:grid-cols-3">
          <dt className="text-sm text-muted-foreground">Organization</dt>
          <dd className="text-sm sm:col-span-2">{organization.name}</dd>
        </div>
      </dl>
      <Link
        to="/preferences"
        className="mt-6 inline-block text-sm font-medium underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        Open Preferences for application appearance
      </Link>
    </section>
  );
}
