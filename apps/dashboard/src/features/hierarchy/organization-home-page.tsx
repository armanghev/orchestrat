import { useDeferredValue, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { FolderOpen, GitBranch, Plus, Search, Users } from "lucide-react";
import type { Organization, ProjectSummary } from "@orchestrat/protocol";
import { TopToolbarActions } from "@/components/app-shell/app-shell";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption
} from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/features/attention/attention-copy";
import { ImportRepositoriesPanel } from "@/features/integrations/import-repositories-panel";
import { providerLabels } from "@/features/repository/repository-copy";
import { cn } from "@/lib/cn";
import {
  organizationProjectsView,
  type OrganizationProjectsFilter,
  type OrganizationProjectsSort,
  type OrganizationProjectsView
} from "@/platform/preferences";
import { usePreferences } from "@/platform/preferences-provider";
import { projectSummariesQueryOptions } from "./query-options";

export function filterOrganizationProjects(
  projects: ProjectSummary[],
  view: OrganizationProjectsView,
  search: string
): ProjectSummary[] {
  const needle = search.trim().toLowerCase();
  const filtered = projects.filter((project) => {
    if (view.filter === "active" && project.status !== "active") return false;
    if (view.filter === "archived" && project.status !== "archived")
      return false;
    if (!needle) return true;
    return (
      project.name.toLowerCase().includes(needle) ||
      project.slug.toLowerCase().includes(needle) ||
      project.task_key_prefix.toLowerCase().includes(needle) ||
      (project.description?.toLowerCase().includes(needle) ?? false)
    );
  });
  const sorted = [...filtered];
  if (view.sort === "name") {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    sorted.sort((a, b) => {
      const aTime = a.last_activity_at
        ? Date.parse(a.last_activity_at)
        : Number.NEGATIVE_INFINITY;
      const bTime = b.last_activity_at
        ? Date.parse(b.last_activity_at)
        : Number.NEGATIVE_INFINITY;
      if (bTime !== aTime) return bTime - aTime;
      return a.name.localeCompare(b.name);
    });
  }
  return sorted;
}

function roleLabel(role: ProjectSummary["role"]) {
  if (!role) return null;
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function ProjectCard({
  project,
  now
}: {
  project: ProjectSummary;
  now: number;
}) {
  const role = roleLabel(project.role);
  return (
    <li className="relative min-w-0">
      <article
        className={cn(
          "flex h-full flex-col gap-2 rounded-xl p-4 ring-1 ring-border transition-colors hover:bg-muted/50",
          project.status === "archived" && "opacity-60"
        )}
      >
        <Link
          to="/projects/$projectId/overview"
          params={{ projectId: project.id }}
          search={{ branch: undefined }}
          className="absolute inset-0 z-0 rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-label={project.name}
        />
        <div className="relative z-10 flex min-w-0 flex-col gap-2 pointer-events-none">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <span className="min-w-0 font-medium break-words">
              {project.name}
            </span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {project.task_key_prefix}
            </span>
          </div>
          {project.description ? (
            <p className="line-clamp-1 text-sm text-muted-foreground">
              {project.description}
            </p>
          ) : null}
          {project.repository ? (
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <GitBranch className="size-3.5 shrink-0" aria-hidden />
              <span className="shrink-0">
                {providerLabels[project.repository.provider]}
              </span>
              <span className="min-w-0 truncate">
                {project.repository.full_name}
              </span>
              {project.default_branch_name ? (
                <span className="shrink-0">
                  · {project.default_branch_name}
                </span>
              ) : null}
            </p>
          ) : (
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId: project.id }}
              hash="repository"
              className="pointer-events-auto w-fit text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
            >
              No repository
            </Link>
          )}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Users className="size-3.5" aria-hidden />
              {project.member_count}{" "}
              {project.member_count === 1 ? "member" : "members"}
            </span>
            <span>
              {project.open_task_count} open{" "}
              {project.open_task_count === 1 ? "task" : "tasks"}
            </span>
            <span>
              {project.last_activity_at
                ? `Active ${relativeTime(project.last_activity_at, now)}`
                : "No activity yet"}
            </span>
            {role ? <span className="capitalize">{role}</span> : null}
          </p>
        </div>
      </article>
    </li>
  );
}

export function OrganizationHomePage({
  organization
}: {
  organization: Organization;
}) {
  const { api } = useRouter().options.context;
  const navigate = useNavigate();
  const { preferences, update } = usePreferences();
  const view = organizationProjectsView(preferences, organization.id);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const now = useMemo(() => Date.now(), []);
  const summaries = useQuery(
    projectSummariesQueryOptions(api, organization.id)
  );

  const createProject = () =>
    void navigate({
      to: "/organizations/$organizationId/projects/new",
      params: { organizationId: organization.id }
    });

  const persistView = (next: OrganizationProjectsView) => {
    void update({
      organizationProjectsViews: {
        ...preferences.organizationProjectsViews,
        [organization.id]: next
      }
    });
  };

  const setSort = (sort: OrganizationProjectsSort) =>
    persistView({ ...view, sort });
  const setFilter = (filter: OrganizationProjectsFilter) =>
    persistView({ ...view, filter });

  const projects = useMemo(
    () =>
      summaries.data
        ? filterOrganizationProjects(
            summaries.data.projects,
            view,
            deferredSearch
          )
        : [],
    [summaries.data, view, deferredSearch]
  );

  const hasAnyProjects = (summaries.data?.projects.length ?? 0) > 0;
  const searching = deferredSearch.trim().length > 0;

  return (
    <section
      className="dashboard-page"
      aria-label={`${organization.name} projects`}
    >
      <TopToolbarActions>
        <Button onClick={createProject}>
          <Plus data-icon="inline-start" />
          New project
        </Button>
      </TopToolbarActions>

      {organization.role !== "member" ? (
        <ImportRepositoriesPanel api={api} organization={organization} />
      ) : null}

      {summaries.isPending ? (
        <div aria-label="Loading projects" className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Skeleton className="h-8 flex-1" />
            <Skeleton className="h-8 w-36" />
            <Skeleton className="h-8 w-36" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-36 rounded-xl" />
            ))}
          </div>
        </div>
      ) : summaries.isError ? (
        <div role="alert" className="flex items-center gap-3 text-sm">
          We couldn’t load the projects.
          <Button
            variant="outline"
            size="sm"
            onClick={() => void summaries.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : !hasAnyProjects ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpen />
            </EmptyMedia>
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>
              Create a project to coordinate agents in {organization.name}.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={createProject}>Create project</Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Search projects</span>
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search projects"
                className="pl-8"
              />
            </label>
            <NativeSelect
              aria-label="Sort projects"
              value={view.sort}
              onChange={(event) =>
                setSort(event.target.value as OrganizationProjectsSort)
              }
            >
              <NativeSelectOption value="recent">
                Recent activity
              </NativeSelectOption>
              <NativeSelectOption value="name">Name</NativeSelectOption>
            </NativeSelect>
            <NativeSelect
              aria-label="Filter projects"
              value={view.filter}
              onChange={(event) =>
                setFilter(event.target.value as OrganizationProjectsFilter)
              }
            >
              <NativeSelectOption value="active">Active</NativeSelectOption>
              <NativeSelectOption value="archived">Archived</NativeSelectOption>
            </NativeSelect>
          </div>
          {projects.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Search />
                </EmptyMedia>
                <EmptyTitle>
                  {searching
                    ? "No matching projects"
                    : view.filter === "archived"
                      ? "No archived projects"
                      : "No active projects"}
                </EmptyTitle>
                <EmptyDescription>
                  {searching
                    ? "Try a different search or clear the filter."
                    : "Switch the filter to see other projects."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {projects.map((project) => (
                <ProjectCard key={project.id} project={project} now={now} />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
