import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { FolderOpen, Plus } from "lucide-react";
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
import { cn } from "@/lib/cn";
import { useOrganizationRoute } from "./_authenticated.organizations.$organizationId";

// ponytail: a plain project list so the organization home works end to end;
// ORC-51 replaces it with the project grid and its summaries.
function OrganizationHome() {
  const { catalog, organization } = useOrganizationRoute();
  const navigate = useNavigate();
  const projects = catalog.projects
    .filter((context) => context.organization.id === organization.id)
    .map(({ project }) => project);
  const createProject = () =>
    void navigate({
      to: "/organizations/$organizationId/projects/new",
      params: { organizationId: organization.id }
    });
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
      {projects.length === 0 ? (
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
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                to="/projects/$projectId/overview"
                params={{ projectId: project.id }}
                search={{ branch: undefined }}
                className={cn(
                  "flex h-full flex-col gap-1 rounded-xl p-4 ring-1 ring-border transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  project.status === "archived" && "opacity-60"
                )}
              >
                <span className="font-medium break-words">{project.name}</span>
                <span className="text-xs text-muted-foreground">
                  {project.status === "archived" ? "Archived" : project.slug}
                </span>
                {project.description ? (
                  <span className="line-clamp-2 text-sm text-muted-foreground">
                    {project.description}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export const Route = createFileRoute(
  "/_authenticated/organizations/$organizationId/"
)({ component: OrganizationHome });
