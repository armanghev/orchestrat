import { useEffect, useRef, useState } from "react";
import type { Organization } from "@orchestrat/protocol";
import {
  createOrganizationRequestSchema,
  createProjectRequestSchema
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
  projectsQueryOptions
} from "./query-options";

type CreationKind = "organization" | "project";
type CreationInput = { name: string; description?: string | null };

function CreationForm({
  kind,
  description,
  pending,
  onSubmit
}: {
  kind: CreationKind;
  description: string;
  pending: boolean;
  onSubmit(input: CreationInput): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const label = kind[0].toUpperCase() + kind.slice(1);

  useEffect(() => heading.current?.focus(), [kind]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const parsed =
      kind === "organization"
        ? createOrganizationRequestSchema.safeParse({ name })
        : createProjectRequestSchema.safeParse({
            name,
            description: projectDescription.trim() || null
          });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the fields and try again.");
      return;
    }
    try {
      await onSubmit({
        name: parsed.data.name,
        ...(kind === "project"
          ? { description: projectDescription.trim() || null }
          : {})
      });
      setName("");
      setProjectDescription("");
    } catch (cause) {
      setError(
        cause instanceof DashboardApiError
          ? cause.message
          : "Unable to create this item."
      );
    }
  }

  return (
    <section className="w-full max-w-md">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight">
        Create your {kind}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor={`${kind}-name`}>{label} name</Label>
          <Input id={`${kind}-name`} value={name} onChange={(event) => setName(event.target.value)} disabled={pending} autoComplete="organization" />
        </div>
        {kind === "project" && (
          <div className="space-y-2">
            <Label htmlFor="project-description">Description (optional)</Label>
            <textarea id="project-description" className="min-h-24 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} disabled={pending} />
          </div>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={pending}>{pending ? `Creating ${kind}...` : `Create ${kind}`}</Button>
      </form>
    </section>
  );
}

function OrganizationPicker({
  selected,
  organizations,
  onSelect
}: {
  selected: Organization;
  organizations: Organization[];
  onSelect(organization: Organization): void;
}) {
  if (organizations.length < 2) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline">{selected.name}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {organizations.map((organization) => (
          <DropdownMenuItem key={organization.id} onSelect={() => onSelect(organization)}>
            {organization.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SetupFlow({ create }: { create?: "organization" | "project" }) {
  const router = useRouter();
  const { api, queryClient } = router.options.context;
  const [selectedOrganization, setSelectedOrganization] = useState<Organization | null>(null);
  const organizationsQuery = useQuery(organizationsQueryOptions(api));
  const organizations = organizationsQuery.data?.organizations ?? [];
  const organization =
    organizations.find(({ id }) => id === selectedOrganization?.id) ??
    selectedOrganization ??
    (create === "organization" ? null : organizations[0]) ??
    null;
  const projectsQuery = useQuery({
    ...projectsQueryOptions(api, organization?.id ?? ""),
    enabled: organization !== null
  });
  const project = create === "project" ? null : projectsQuery.data?.projects[0] ?? null;
  const organizationMutation = useMutation({
    mutationFn: (input: CreationInput) =>
      api.createOrganization(createOrganizationRequestSchema.parse({ name: input.name }))
  });
  const projectMutation = useMutation({
    mutationFn: (input: CreationInput) =>
      api.createProject(
        organization!.id,
        createProjectRequestSchema.parse({ name: input.name, description: input.description ?? null })
      )
  });

  useEffect(() => {
    if (!project) return;
    void (router.navigate as (options: { to: string }) => Promise<unknown>)({
      to: `/projects/${project.id}/overview`
    });
  }, [project, router]);

  if (organizationsQuery.isPending) return <p role="status">Loading organizations...</p>;
  if (organizationsQuery.isError) return <p role="alert">We couldn't load your organizations.</p>;
  if (!organization)
    return <CreationForm kind="organization" description="Create an organization for your projects." pending={organizationMutation.isPending} onSubmit={async (input) => {
      const created = await organizationMutation.mutateAsync(input);
      setSelectedOrganization(created);
      await queryClient.invalidateQueries({ queryKey: hierarchyKeys.organizations() });
    }} />;
  if (projectsQuery.isPending) return <p role="status">Loading projects...</p>;
  if (projectsQuery.isError) return <p role="alert">We couldn't load this organization's projects.</p>;
  if (project) return <p role="status">Opening project...</p>;
  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">Organization: {organization.name}</p>
      <OrganizationPicker selected={organization} organizations={organizations} onSelect={setSelectedOrganization} />
      <CreationForm kind="project" description="Create a project in this organization." pending={projectMutation.isPending} onSubmit={async (input) => {
        const created = await projectMutation.mutateAsync(input);
        await queryClient.invalidateQueries({ queryKey: hierarchyKeys.catalog() });
        await (router.navigate as (options: { to: string }) => Promise<unknown>)({ to: `/projects/${created.id}/overview` });
      }} />
    </section>
  );
}
