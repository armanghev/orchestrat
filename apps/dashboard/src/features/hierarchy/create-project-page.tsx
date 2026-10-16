import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { FolderPlus, GitBranch, Search } from "lucide-react";
import {
  createProjectRequestSchema,
  importRepositoryProjectRequestSchema,
  type Organization,
  type OrganizationRepository,
  type RepositoryProvider
} from "@orchestrat/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { DashboardApiError, type ApiClient } from "@/lib/api/client";
import { usePlatform } from "@/platform/provider";
import { repositoryProvidersQueryOptions } from "@/features/repository/query-options";
import { goTo } from "@/features/repository/redirect";
import {
  REPOSITORY_ATTEMPT_KEY,
  providerLabels
} from "@/features/repository/repository-copy";
import {
  repositoryShortName,
  sortRepositories
} from "@/features/integrations/integration-copy";
import {
  hierarchyKeys,
  organizationIntegrationsQueryOptions,
  organizationRepositoriesQueryOptions
} from "./query-options";

type Source = "empty" | RepositoryProvider;

/** The API's default when no key is sent: the first three letters or
 * digits of the slug, or PRJ (project-service.ts createProject). */
export function deriveTaskKey(name: string) {
  const letters = name.replace(/[^a-z0-9]/gi, "").slice(0, 3);
  return letters.length >= 2 ? letters.toUpperCase() : "PRJ";
}

function importErrorMessage(error: unknown) {
  if (!(error instanceof DashboardApiError))
    return "We couldn’t import this repository. Try again.";
  if (error.kind === "REPOSITORY_CONNECTION_EXISTS")
    return "That repository is already a project.";
  if (error.kind === "PERMISSION_DENIED")
    return "Only organization owners and admins can import repositories.";
  return error.message;
}

export function CreateProjectPage({
  api,
  organization,
  repositoryId
}: {
  api: ApiClient;
  organization: Organization;
  /** Import mode: the organization repository to create the project from. */
  repositoryId?: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const platform = usePlatform();
  const nameInput = useRef<HTMLInputElement>(null);
  // null until the person types, so an imported repository can name it.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [taskKey, setTaskKey] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [repositorySearch, setRepositorySearch] = useState("");
  const canImport = organization.role !== "member";
  const providers = useQuery(repositoryProvidersQueryOptions(api));
  const integrations = useQuery({
    ...organizationIntegrationsQueryOptions(api, organization.id),
    enabled: canImport
  });
  const repositories = useQuery({
    ...organizationRepositoriesQueryOptions(api, organization.id, "importable"),
    enabled: canImport
  });
  const hasIntegrations = (integrations.data?.integrations.length ?? 0) > 0;
  const importable = useMemo(
    () => sortRepositories(repositories.data?.repositories ?? []),
    [repositories.data]
  );
  const importMode = canImport && Boolean(repositoryId);
  const importing: OrganizationRepository | undefined = importMode
    ? importable.find((repository) => repository.id === repositoryId)
    : undefined;
  const available = providers.data?.providers ?? [];
  const anyConfigured = available.some((provider) => provider.configured);
  const name =
    nameDraft ?? (importing ? repositoryShortName(importing.full_name) : "");
  const shownTaskKey = taskKey ?? deriveTaskKey(name);

  useEffect(() => nameInput.current?.focus(), []);

  const chooseRepository = (id: string | undefined) => {
    setImportError(null);
    void navigate({
      to: "/organizations/$organizationId/projects/new",
      params: { organizationId: organization.id },
      search: { repository: id },
      replace: true
    });
  };

  const create = useMutation({
    mutationFn: async (source: Source) => {
      const input = createProjectRequestSchema.parse({
        name,
        description: description.trim() || null,
        task_key_prefix: shownTaskKey
      });
      const project = await api.createProject(organization.id, input);
      await queryClient.invalidateQueries({
        queryKey: hierarchyKeys.all,
        refetchType: "none"
      });
      if (source === "empty") return { project, source };
      try {
        const authorization = await api.authorizeRepository(project.id, {
          provider: source,
          return_path: `/projects/${project.id}/connect`
        });
        return { project, source, authorization };
      } catch {
        // The project exists either way; the connect page says what failed
        // and offers Try again or Skip.
        return { project, source, authorization: null };
      }
    },
    onSuccess: async ({ project, source, authorization }) => {
      if (source === "empty" || authorization === undefined) {
        await navigate({
          to: "/projects/$projectId/overview",
          params: { projectId: project.id },
          search: { branch: undefined }
        });
        return;
      }
      if (!authorization) {
        await navigate({
          to: "/projects/$projectId/connect",
          params: { projectId: project.id },
          search: { repository_error: "authorization_failed" }
        });
        return;
      }
      // The GitHub Setup URL comes back without our state; this attempt is
      // how the setup route finds its way.
      window.sessionStorage.setItem(
        REPOSITORY_ATTEMPT_KEY,
        JSON.stringify({
          authorization_id: authorization.authorization_id,
          project_id: project.id,
          provider: source
        })
      );
      if (platform.kind === "desktop") {
        // The provider returns to the browser, so the desktop app waits on
        // the repository section, which shows the connection once it lands.
        await platform.openExternal(new URL(authorization.authorize_url));
        await navigate({
          to: "/projects/$projectId/settings",
          params: { projectId: project.id },
          search: { branch: undefined },
          hash: "repository"
        });
      } else goTo(authorization.authorize_url);
    },
    onError: (cause) =>
      setError(
        cause instanceof DashboardApiError
          ? cause.message
          : "We couldn’t create this project. Try again."
      )
  });

  const importProject = useMutation({
    mutationFn: (repository: OrganizationRepository) =>
      api.importRepositoryProject(
        organization.id,
        importRepositoryProjectRequestSchema.parse({
          repository_id: repository.id,
          name,
          description: description.trim() || null,
          task_key_prefix: shownTaskKey
        })
      ),
    onSuccess: async ({ project }) => {
      await queryClient.invalidateQueries({ queryKey: hierarchyKeys.all });
      await navigate({
        to: "/projects/$projectId/overview",
        params: { projectId: project.id },
        search: { branch: undefined }
      });
    },
    onError: (cause) => setImportError(importErrorMessage(cause))
  });

  /** Checks the fields; false (with the error shown) when they don't pass. */
  const validate = () => {
    setError(null);
    const parsed = createProjectRequestSchema.safeParse({
      name,
      description: description.trim() || null,
      task_key_prefix: shownTaskKey
    });
    if (parsed.success) return true;
    const issue = parsed.error.issues[0];
    setError(
      issue?.path[0] === "task_key_prefix"
        ? "Task key must be 2–8 letters or digits."
        : issue?.path[0] === "name"
          ? "Enter a project name."
          : (issue?.message ?? "Check the fields and try again.")
    );
    if (issue?.path[0] === "name") nameInput.current?.focus();
    return false;
  };

  const submit = (source: Source) => {
    if (validate()) create.mutate(source);
  };

  const submitImport = () => {
    setImportError(null);
    if (!importing || !validate()) return;
    importProject.mutate(importing);
  };

  const pending =
    create.isPending ||
    create.isSuccess ||
    importProject.isPending ||
    importProject.isSuccess;
  const pendingSource = create.variables;
  const repositoryTerm = repositorySearch.trim().toLowerCase();
  const shownRepositories = importable.filter((repository) =>
    repository.full_name.toLowerCase().includes(repositoryTerm)
  );
  const integrationsLink = (label: string) => (
    <Link
      to="/organizations/$organizationId/integrations"
      params={{ organizationId: organization.id }}
      search={{
        repository_authorization: undefined,
        repository_error: undefined
      }}
      className="font-medium text-foreground underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      {label}
    </Link>
  );

  return (
    <form
      className="dashboard-page grid max-w-5xl gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      aria-label={`New project in ${organization.name}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (importMode) submitImport();
        else submit("empty");
      }}
    >
      {importMode ? (
        <section
          aria-label="Repository to import"
          className="grid gap-2 rounded-xl p-4 ring-1 ring-border md:col-span-2"
        >
          {repositories.isPending || integrations.isPending ? (
            <Skeleton className="h-6 w-72" />
          ) : repositories.isError ? (
            <div role="alert" className="flex items-center gap-3 text-sm">
              We couldn’t load the repository.
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void repositories.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <GitBranch
                aria-hidden="true"
                className="size-5 shrink-0 text-muted-foreground"
              />
              <p className="min-w-0 flex-1 text-sm">
                {importing ? (
                  <>
                    Importing{" "}
                    <span className="font-medium break-words">
                      {importing.full_name}
                    </span>{" "}
                    from {providerLabels[importing.provider]}
                  </>
                ) : (
                  "That repository isn’t available to import. It may already be a project, or it was dismissed."
                )}
              </p>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="px-0"
                disabled={pending}
                onClick={() => chooseRepository(undefined)}
              >
                Choose another
              </Button>
            </div>
          )}
          {importError ? (
            <p role="alert" className="text-sm text-destructive">
              {importError}
            </p>
          ) : null}
        </section>
      ) : null}

      <section
        className="flex flex-col gap-5"
        aria-labelledby="project-details"
      >
        <div>
          <h2 id="project-details" className="text-base font-medium">
            Project details
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Projects hold the tasks, documents and chats your agents share in{" "}
            {organization.name}.
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="project-name">Project name</Label>
          <Input
            ref={nameInput}
            id="project-name"
            value={name}
            onChange={(event) => setNameDraft(event.target.value)}
            disabled={pending}
            autoComplete="off"
            aria-invalid={error === "Enter a project name." || undefined}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="task-key">Task key</Label>
          <Input
            id="task-key"
            value={shownTaskKey}
            onChange={(event) =>
              setTaskKey(
                event.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase()
              )
            }
            maxLength={8}
            disabled={pending}
            autoComplete="off"
            aria-describedby="task-key-hint"
            className="w-40 font-mono"
          />
          <p id="task-key-hint" className="text-xs text-muted-foreground">
            Tasks are numbered{" "}
            <span className="font-mono">{shownTaskKey || "KEY"}-1</span>,{" "}
            <span className="font-mono">{shownTaskKey || "KEY"}-2</span>, …
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="project-description">Description (optional)</Label>
          <Textarea
            id="project-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={pending}
            rows={4}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {importMode ? (
          <Button
            type="submit"
            className="w-fit"
            disabled={pending || !importing}
          >
            {importProject.isPending || importProject.isSuccess
              ? "Importing…"
              : "Import"}
          </Button>
        ) : null}
      </section>

      <section className="flex flex-col gap-5" aria-labelledby="project-source">
        <div>
          <h2 id="project-source" className="text-base font-medium">
            Source
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {hasIntegrations
              ? "Import a repository your organization’s Git accounts reach, or start empty."
              : "Connect a Git repository so branches stay in sync, or start empty and connect one later in project settings."}
          </p>
        </div>
        {canImport && integrations.isPending ? (
          <div className="grid gap-2" aria-label="Loading sources">
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-16 rounded-xl" />
          </div>
        ) : canImport && integrations.isError ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-xl p-4 text-sm ring-1 ring-border"
          >
            We couldn’t load your organization’s Git accounts.
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void integrations.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : hasIntegrations ? (
          <div className="grid gap-3">
            <div className="relative">
              <Label htmlFor="repository-search" className="sr-only">
                Search repositories
              </Label>
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                id="repository-search"
                value={repositorySearch}
                onChange={(event) => setRepositorySearch(event.target.value)}
                placeholder="Search repositories"
                className="pl-8"
                autoComplete="off"
              />
            </div>
            {repositories.isPending ? (
              <Skeleton className="h-24 rounded-xl" />
            ) : repositories.isError ? (
              <div role="alert" className="flex items-center gap-3 text-sm">
                We couldn’t load the repositories.
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void repositories.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : shownRepositories.length === 0 ? (
              <p className="rounded-xl p-4 text-sm text-muted-foreground ring-1 ring-border">
                {importable.length === 0
                  ? "Every repository your Git accounts reach is already a project."
                  : "No repositories match your search."}
              </p>
            ) : (
              <ul
                aria-label="Repositories to import"
                className="grid max-h-80 divide-y overflow-y-auto rounded-xl ring-1 ring-border"
              >
                {shownRepositories.map((repository) => (
                  <li
                    key={repository.id}
                    className="flex min-w-0 items-center gap-3 px-4 py-2.5"
                  >
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate text-sm font-medium">
                        {repository.full_name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {providerLabels[repository.provider]}
                      </span>
                    </span>
                    {repository.id === repositoryId ? (
                      <span className="text-xs text-muted-foreground">
                        Selected
                      </span>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={`Import ${repository.full_name}`}
                        disabled={pending}
                        onClick={() => chooseRepository(repository.id)}
                      >
                        Import
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-sm">
              {integrationsLink("Connect another account")}
            </p>
          </div>
        ) : (
          <>
            <ul className="grid gap-2">
              {providers.isPending ? (
                <>
                  <li>
                    <Skeleton className="h-16 rounded-xl" />
                  </li>
                  <li>
                    <Skeleton className="h-16 rounded-xl" />
                  </li>
                </>
              ) : providers.isError ? (
                <li
                  role="alert"
                  className="flex items-center justify-between gap-3 rounded-xl p-4 text-sm ring-1 ring-border"
                >
                  We couldn’t load the Git providers.
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void providers.refetch()}
                  >
                    Retry
                  </Button>
                </li>
              ) : (
                available.map((provider) => (
                  <li
                    key={provider.provider}
                    className="flex flex-wrap items-center gap-3 rounded-xl p-4 ring-1 ring-border"
                  >
                    <GitBranch
                      aria-hidden="true"
                      className="size-5 shrink-0 text-muted-foreground"
                    />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="text-sm font-medium">
                        {providerLabels[provider.provider]}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {provider.configured
                          ? "Pick a repository after you approve access."
                          : (provider.unavailable_reason ??
                            "Not set up on this server.")}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!provider.configured || pending}
                      onClick={() => submit(provider.provider)}
                    >
                      {pending && pendingSource === provider.provider
                        ? "Creating…"
                        : `Create and connect ${providerLabels[provider.provider]}`}
                    </Button>
                  </li>
                ))
              )}
            </ul>
            {canImport ? (
              <p className="text-sm text-muted-foreground">
                Connect GitHub or GitLab once in{" "}
                {integrationsLink("Integrations")} to import any of the
                organization’s repositories.
              </p>
            ) : null}
          </>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t pt-5">
          <FolderPlus
            aria-hidden="true"
            className="size-5 shrink-0 text-muted-foreground"
          />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="text-sm font-medium">Empty project</span>
            <span className="text-xs text-muted-foreground">
              No repository for now.
            </span>
          </span>
          <Button
            type={importMode ? "button" : "submit"}
            variant={anyConfigured || hasIntegrations ? "ghost" : "default"}
            disabled={pending}
            onClick={importMode ? () => submit("empty") : undefined}
          >
            {(create.isPending || create.isSuccess) && pendingSource === "empty"
              ? "Creating…"
              : "Create empty project"}
          </Button>
        </div>
      </section>
    </form>
  );
}
