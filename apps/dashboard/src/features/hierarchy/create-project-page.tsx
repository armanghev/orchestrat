import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FolderPlus, GitBranch } from "lucide-react";
import {
  createProjectRequestSchema,
  type Organization,
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
import { hierarchyKeys } from "./query-options";

type Source = "empty" | RepositoryProvider;

/** The API's default when no key is sent: the first three letters or
 * digits of the slug, or PRJ (project-service.ts createProject). */
export function deriveTaskKey(name: string) {
  const letters = name.replace(/[^a-z0-9]/gi, "").slice(0, 3);
  return letters.length >= 2 ? letters.toUpperCase() : "PRJ";
}

export function CreateProjectPage({
  api,
  organization
}: {
  api: ApiClient;
  organization: Organization;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const platform = usePlatform();
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [taskKey, setTaskKey] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const providers = useQuery(repositoryProvidersQueryOptions(api));
  const available = providers.data?.providers ?? [];
  const anyConfigured = available.some((provider) => provider.configured);
  const shownTaskKey = taskKey ?? deriveTaskKey(name);

  useEffect(() => nameInput.current?.focus(), []);

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
      // how the setup route finds its way (docs/project-branches.md §11.8).
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

  const submit = (source: Source) => {
    setError(null);
    const parsed = createProjectRequestSchema.safeParse({
      name,
      description: description.trim() || null,
      task_key_prefix: shownTaskKey
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(
        issue?.path[0] === "task_key_prefix"
          ? "Task key must be 2–8 letters or digits."
          : issue?.path[0] === "name"
            ? "Enter a project name."
            : (issue?.message ?? "Check the fields and try again.")
      );
      if (issue?.path[0] === "name") nameInput.current?.focus();
      return;
    }
    create.mutate(source);
  };

  const pending = create.isPending || create.isSuccess;
  const pendingSource = create.variables;

  return (
    <form
      className="dashboard-page grid max-w-5xl gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
      aria-label={`New project in ${organization.name}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit("empty");
      }}
    >
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
            onChange={(event) => setName(event.target.value)}
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
      </section>

      <section className="flex flex-col gap-5" aria-labelledby="project-source">
        <div>
          <h2 id="project-source" className="text-base font-medium">
            Source
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect a Git repository so branches stay in sync, or start empty
            and connect one later in project settings.
          </p>
        </div>
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
            type="submit"
            variant={anyConfigured ? "ghost" : "default"}
            disabled={pending}
          >
            {pending && pendingSource === "empty"
              ? "Creating…"
              : "Create empty project"}
          </Button>
        </div>
      </section>
    </form>
  );
}
