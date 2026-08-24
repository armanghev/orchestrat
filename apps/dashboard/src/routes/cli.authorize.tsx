import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { SignInScreen } from "@/features/auth/sign-in-screen";
import { useAuthSnapshot } from "@/features/auth/auth-context";
import { projectCatalogQueryOptions } from "@/features/hierarchy/query-options";

export const CLI_ATTEMPT_KEY = "orchestrat.cli.authorization.attempt";
export const CLI_TERMINAL_KEY = "orchestrat.cli.authorization.terminal";
export const attemptPattern = /^ca_[A-Za-z0-9_-]{20,}$/;
type TerminalState = { status: "approved" | "denied"; attempt?: string };

function clearAttemptQuery() {
  window.history.replaceState(window.history.state, "", "/cli/authorize");
}

function CliAuthorizeRoute() {
  const { attempt } = Route.useSearch();
  const auth = useAuthSnapshot();
  const { api } = Route.useRouteContext();
  const [projectId, setProjectId] = useState("");
  const [terminal, setTerminal] = useState<TerminalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const valid = attemptPattern.test(attempt ?? "");
  const showTerminal =
    terminal !== null &&
    (terminal.attempt === attempt ||
      (attempt === undefined && terminal.attempt === undefined));
  const catalog = useQuery({
    ...projectCatalogQueryOptions(api),
    enabled: valid && auth.status === "signedIn"
  });

  useEffect(() => {
    if (valid) window.sessionStorage.removeItem(CLI_TERMINAL_KEY);
    else if (attempt === undefined) {
      try {
        const value = JSON.parse(
          window.sessionStorage.getItem(CLI_TERMINAL_KEY) ?? "null"
        ) as Partial<TerminalState> | null;
        if (value?.status === "approved" || value?.status === "denied")
          setTerminal({ status: value.status });
      } catch {
        window.sessionStorage.removeItem(CLI_TERMINAL_KEY);
      }
    }
    if (!valid || auth.status === "signedIn")
      window.sessionStorage.removeItem(CLI_ATTEMPT_KEY);
    else if (auth.status !== "loading")
      window.sessionStorage.setItem(CLI_ATTEMPT_KEY, attempt!);
  }, [attempt, auth.status, valid]);

  if (!valid && !showTerminal)
    return (
      <main className="mx-auto max-w-xl px-6 py-16" role="alert">
        <h1 className="text-xl font-semibold">Invalid authorization link</h1>
        <p className="mt-2">
          This CLI authorization link is invalid or incomplete.
        </p>
      </main>
    );
  if (auth.status === "loading")
    return (
      <main className="mx-auto max-w-xl px-6 py-16" aria-busy="true">
        Restoring session…
      </main>
    );
  if (auth.status !== "signedIn") {
    return <SignInScreen />;
  }
  if (showTerminal)
    return (
      <main className="mx-auto max-w-xl px-6 py-16" role="status">
        <h1 className="text-xl font-semibold">CLI access {terminal.status}.</h1>
        <p className="mt-2">You can return to your terminal.</p>
      </main>
    );

  const decide = async (action: "approve" | "deny") => {
    if (action === "approve" && !projectId) return;
    setBusy(true);
    setError(false);
    try {
      if (action === "approve")
        await api.approveCliAuthorization(attempt!, projectId);
      else await api.denyCliAuthorization(attempt!);
      window.sessionStorage.setItem(
        CLI_TERMINAL_KEY,
        JSON.stringify({ status: action === "approve" ? "approved" : "denied" })
      );
      window.sessionStorage.removeItem(CLI_ATTEMPT_KEY);
      clearAttemptQuery();
      setTerminal({
        status: action === "approve" ? "approved" : "denied",
        attempt: attempt!
      });
    } catch {
      setTerminal(null);
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 px-6 py-16">
      <div>
        <h1 className="text-2xl font-semibold">Authorize Orchestrat CLI</h1>
        <p className="mt-2 text-muted-foreground">
          Choose a project for this CLI connection.
        </p>
      </div>
      {catalog.isLoading && (
        <p role="status" aria-busy="true">
          Loading projects…
        </p>
      )}
      {catalog.isError && (
        <p role="alert">
          Unable to load projects. You can still deny this request.
        </p>
      )}
      {!catalog.isError && (
        <label
          className="flex flex-col gap-2 text-sm font-medium"
          htmlFor="cli-project"
        >
          Project
          <select
            id="cli-project"
            className="control-field"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            disabled={busy || catalog.isLoading}
          >
            <option value="">Select a project</option>
            {catalog.data?.projects.map(({ organization, project }) => (
              <option key={project.id} value={project.id}>
                {organization.name} / {project.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p role="alert">Unable to update CLI authorization. Try again.</p>
      )}
      <div className="flex gap-3">
        <Button
          type="button"
          onClick={() => void decide("approve")}
          disabled={busy || !projectId || catalog.isError}
        >
          Approve
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void decide("deny")}
          disabled={busy}
        >
          Deny
        </Button>
      </div>
    </main>
  );
}

export const Route = createFileRoute("/cli/authorize")({
  validateSearch: z.object({ attempt: z.string().optional() }).strict(),
  component: CliAuthorizeRoute
});
