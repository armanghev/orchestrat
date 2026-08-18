import { useEffect, useRef, useState } from "react";
import type { Organization, Workspace } from "@orchestrat/protocol";
import {
  createOrganizationRequestSchema,
  createProjectRequestSchema,
  createWorkspaceRequestSchema
} from "@orchestrat/protocol";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DashboardApiError } from "@/lib/api/client";
import {
  hierarchyKeys,
  organizationsQueryOptions,
  projectsQueryOptions,
  workspacesQueryOptions
} from "./query-options";

type CreationKind = "organization" | "workspace" | "project";
type CreationInput = { name: string; description?: string | null };
type CreationField = "name" | "description";

type CreationFormProps = {
  kind: CreationKind;
  description: string;
  pending: boolean;
  onSubmit(input: CreationInput): Promise<void>;
};

function serverErrorField(
  kind: CreationKind,
  error: DashboardApiError
): CreationField {
  if (kind !== "project") return "name";
  const issues = error.details.issues;
  return Array.isArray(issues) &&
    issues.some(
      (issue) =>
        typeof issue === "object" &&
        issue !== null &&
        Array.isArray((issue as { path?: unknown }).path) &&
        (issue as { path: unknown[] }).path[0] === "description"
    )
    ? "description"
    : "name";
}

const mutationKeys = {
  organization: ["hierarchy", "organizations", "create"] as const,
  workspace: (organizationId: string) =>
    [
      "hierarchy",
      "organizations",
      organizationId,
      "workspaces",
      "create"
    ] as const,
  project: (workspaceId: string) =>
    ["hierarchy", "workspaces", workspaceId, "projects", "create"] as const
};

function CreationForm({
  kind,
  description,
  pending,
  onSubmit
}: CreationFormProps) {
  const [name, setName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [error, setError] = useState<DashboardApiError | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null
  );
  const [validationField, setValidationField] = useState<CreationField | null>(
    null
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const submitting = useRef(false);
  const label = kind[0].toUpperCase() + kind.slice(1);
  const fieldWithError =
    validationField ?? (error ? serverErrorField(kind, error) : null);
  const errorId = fieldWithError
    ? `${kind}-${fieldWithError}-error`
    : undefined;

  useEffect(() => {
    heading.current?.focus();
  }, [kind]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || pending) return;
    setError(null);
    setValidationMessage(null);
    setValidationField(null);
    const input =
      kind === "organization"
        ? createOrganizationRequestSchema.safeParse({ name })
        : kind === "workspace"
          ? createWorkspaceRequestSchema.safeParse({ name })
          : createProjectRequestSchema.safeParse({
              name,
              description: projectDescription.trim() || null
            });

    if (!input.success) {
      const issue = input.error.issues[0];
      setValidationMessage(issue?.message ?? "Check the fields and try again.");
      setValidationField(
        kind === "project" && issue?.path[0] === "description"
          ? "description"
          : "name"
      );
      return;
    }

    submitting.current = true;
    try {
      await onSubmit({
        name: input.data.name,
        ...(kind === "project"
          ? { description: projectDescription.trim() || null }
          : {})
      });
      setName("");
      setProjectDescription("");
    } catch (cause) {
      setError(
        cause instanceof DashboardApiError
          ? cause
          : new DashboardApiError(
              "Unable to create this item.",
              "INTERNAL_ERROR",
              null,
              null
            )
      );
    } finally {
      submitting.current = false;
    }
  }

  return (
    <section
      aria-labelledby={`${kind}-setup-heading`}
      className="w-full max-w-md"
    >
      <h1
        ref={heading}
        id={`${kind}-setup-heading`}
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight"
      >
        Create your {kind}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor={`${kind}-name`}>{label} name</Label>
          <Input
            id={`${kind}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={pending}
            aria-invalid={fieldWithError === "name" || undefined}
            aria-describedby={fieldWithError === "name" ? errorId : undefined}
            autoComplete="organization"
          />
        </div>
        {kind === "project" && (
          <div className="space-y-2">
            <Label htmlFor="project-description">Description (optional)</Label>
            <textarea
              id="project-description"
              className="min-h-24 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              value={projectDescription}
              onChange={(event) => setProjectDescription(event.target.value)}
              disabled={pending}
              aria-invalid={fieldWithError === "description" || undefined}
              aria-describedby={
                fieldWithError === "description" ? errorId : undefined
              }
            />
          </div>
        )}
        {validationMessage && (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {validationMessage}
          </p>
        )}
        {error && (
          <div
            id={errorId}
            role="alert"
            className="space-y-1 text-sm text-destructive"
          >
            <p>{error.message}</p>
            {error.requestId && (
              <p className="text-muted-foreground">
                Reference {error.requestId}
              </p>
            )}
          </div>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? `Creating ${kind}…` : `Create ${kind}`}
        </Button>
      </form>
    </section>
  );
}

function ParentPicker<T extends { id: string; name: string }>({
  label,
  selected,
  parents,
  onSelect
}: {
  label: string;
  selected: T;
  parents: T[];
  onSelect(parent: T): void;
}) {
  if (parents.length < 2) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" aria-label={`Select ${label}`}>
          {selected.name}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {parents.map((parent) => (
          <DropdownMenuItem key={parent.id} onSelect={() => onSelect(parent)}>
            {parent.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function QueryFailure({ retry }: { retry(): void }) {
  return (
    <section className="w-full max-w-md" aria-live="polite">
      <h1 className="text-2xl font-semibold tracking-tight">
        We couldn’t load your setup
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Try again to continue.
      </p>
      <Button className="mt-6" type="button" onClick={retry}>
        Try again
      </Button>
    </section>
  );
}

export function SetupFlow() {
  const router = useRouter();
  const { api, queryClient } = router.options.context;
  const [selectedOrganization, setSelectedOrganization] =
    useState<Organization | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(
    null
  );
  const organizationsQuery = useQuery(organizationsQueryOptions(api));
  const organizations = organizationsQuery.data?.organizations ?? [];
  const organization =
    organizations.find(({ id }) => id === selectedOrganization?.id) ??
    selectedOrganization ??
    organizations[0] ??
    null;
  const workspacesQuery = useQuery({
    ...workspacesQueryOptions(api, organization?.id ?? ""),
    enabled: organization !== null
  });
  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const workspace =
    workspaces.find(({ id }) => id === selectedWorkspace?.id) ??
    (selectedWorkspace?.organization_id === organization?.id
      ? selectedWorkspace
      : null) ??
    workspaces[0] ??
    null;
  const projectsQuery = useQuery({
    ...projectsQueryOptions(api, workspace?.id ?? ""),
    enabled: workspace !== null
  });
  const project = projectsQuery.data?.projects[0] ?? null;

  const organizationMutation = useMutation({
    mutationKey: mutationKeys.organization,
    mutationFn: (input: CreationInput) =>
      api.createOrganization(
        createOrganizationRequestSchema.parse({ name: input.name })
      )
  });
  const workspaceMutation = useMutation({
    mutationKey: mutationKeys.workspace(organization?.id ?? ""),
    mutationFn: (input: CreationInput) =>
      api.createWorkspace(
        organization!.id,
        createWorkspaceRequestSchema.parse({ name: input.name })
      )
  });
  const projectMutation = useMutation({
    mutationKey: mutationKeys.project(workspace?.id ?? ""),
    mutationFn: (input: CreationInput) =>
      api.createProject(
        workspace!.id,
        createProjectRequestSchema.parse({
          name: input.name,
          description: input.description ?? null
        })
      )
  });

  useEffect(() => {
    if (!project) return;
    void (router.navigate as (options: { to: string }) => Promise<unknown>)({
      to: `/projects/${project.id}/overview`
    });
  }, [project, router]);

  if (organizationsQuery.isPending)
    return <p role="status">Loading organizations…</p>;
  if (organizationsQuery.isError)
    return (
      <QueryFailure
        retry={() => {
          void organizationsQuery.refetch();
        }}
      />
    );
  if (!organization)
    return (
      <CreationForm
        kind="organization"
        description="Start by creating an organization for your team."
        pending={organizationMutation.isPending}
        onSubmit={async (input) => {
          const created = await organizationMutation.mutateAsync(input);
          setSelectedOrganization(created);
          await queryClient.invalidateQueries({
            queryKey: hierarchyKeys.organizations()
          });
        }}
      />
    );

  if (workspacesQuery.isPending)
    return <p role="status">Loading workspaces…</p>;
  if (workspacesQuery.isError)
    return (
      <QueryFailure
        retry={() => {
          void workspacesQuery.refetch();
        }}
      />
    );
  if (!workspace)
    return (
      <section className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Organization: {organization.name}
        </p>
        <ParentPicker
          label="organization"
          selected={organization}
          parents={organizations}
          onSelect={(item) => {
            setSelectedOrganization(item);
            setSelectedWorkspace(null);
          }}
        />
        <CreationForm
          kind="workspace"
          description="Create a workspace to organize this organization’s projects."
          pending={workspaceMutation.isPending}
          onSubmit={async (input) => {
            const created = await workspaceMutation.mutateAsync(input);
            setSelectedWorkspace(created);
            await queryClient.invalidateQueries({
              queryKey: hierarchyKeys.workspaces(organization.id)
            });
          }}
        />
      </section>
    );

  if (projectsQuery.isPending) return <p role="status">Loading projects…</p>;
  if (projectsQuery.isError)
    return (
      <QueryFailure
        retry={() => {
          void projectsQuery.refetch();
        }}
      />
    );
  if (project) return <p role="status">Opening project…</p>;
  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Organization: {organization.name}
      </p>
      <ParentPicker
        label="organization"
        selected={organization}
        parents={organizations}
        onSelect={(item) => {
          setSelectedOrganization(item);
          setSelectedWorkspace(null);
        }}
      />
      <p className="text-sm text-muted-foreground">
        Workspace: {workspace.name}
      </p>
      <ParentPicker<Workspace>
        label="workspace"
        selected={workspace}
        parents={workspaces}
        onSelect={(item) => setSelectedWorkspace(item)}
      />
      <CreationForm
        kind="project"
        description="Create the first project in this workspace."
        pending={projectMutation.isPending}
        onSubmit={async (input) => {
          const created = await projectMutation.mutateAsync(input);
          queryClient.setQueryData(
            projectsQueryOptions(api, workspace.id).queryKey,
            { projects: [created] }
          );
          await queryClient.invalidateQueries({
            queryKey: hierarchyKeys.catalog()
          });
          await (
            router.navigate as (options: { to: string }) => Promise<unknown>
          )({
            to: `/projects/${created.id}/overview`
          });
        }}
      />
    </section>
  );
}
