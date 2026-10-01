import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { DashboardApiError, type ApiClient } from "@/lib/api/client";
import { goTo } from "./redirect";
import {
  REPOSITORY_ATTEMPT_KEY,
  authorizationPattern
} from "./repository-copy";

const attemptSchema = z.object({
  authorization_id: z.string().regex(authorizationPattern),
  project_id: z.string().uuid(),
  provider: z.literal("github")
});
type Attempt = z.infer<typeof attemptSchema>;

/** The GitHub attempt this browser started, if it's still valid. */
export function readGithubAttempt(): Attempt | null {
  try {
    const parsed = attemptSchema.safeParse(
      JSON.parse(
        window.sessionStorage.getItem(REPOSITORY_ATTEMPT_KEY) ?? "null"
      )
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// GitHub's Setup URL lands here after an app install (docs/project-branches.md
// §8.3, §11.8). Its installation_id is untrusted: the API accepts it only
// when the authorizing user's token lists that installation.
export function GithubSetup({
  api,
  installationId
}: {
  api: ApiClient;
  installationId?: string;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [attempt] = useState(readGithubAttempt);
  const started = useRef(false);
  const validInstallation = /^[1-9][0-9]{0,19}$/.test(installationId ?? "");
  useEffect(() => {
    if (started.current || !attempt || !validInstallation) return;
    started.current = true;
    void api
      .submitGithubInstallation(
        attempt.project_id,
        attempt.authorization_id,
        installationId!
      )
      .then((result) => {
        if (result.next === "authorize") {
          goTo(result.authorize_url);
          return;
        }
        window.sessionStorage.removeItem(REPOSITORY_ATTEMPT_KEY);
        void navigate({
          to: "/projects/$projectId/settings",
          params: { projectId: attempt.project_id },
          search: { repository_authorization: attempt.authorization_id },
          replace: true
        });
      })
      .catch((cause: unknown) => {
        window.sessionStorage.removeItem(REPOSITORY_ATTEMPT_KEY);
        setError(
          cause instanceof DashboardApiError &&
            cause.kind === "REPOSITORY_AUTHORIZATION_INVALID"
            ? "GitHub didn’t confirm this installation for your account. Start again from the project’s settings."
            : "We couldn’t finish connecting GitHub. Start again from the project’s settings."
        );
      });
  }, [api, attempt, installationId, navigate, validInstallation]);
  const failure =
    error ??
    (!attempt
      ? "This browser didn’t start a GitHub connection, or it expired. Start again from the project’s settings."
      : !validInstallation
        ? "GitHub didn’t say which installation to use. Start again from the project’s settings."
        : null);
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Connect GitHub</h1>
      {failure ? (
        <>
          <p role="alert" className="mt-2 text-sm text-muted-foreground">
            {failure}
          </p>
          {attempt ? (
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId: attempt.project_id }}
              className="mt-6 w-fit text-sm font-medium underline"
            >
              Back to settings
            </Link>
          ) : null}
        </>
      ) : (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          Checking the installation with GitHub…
        </p>
      )}
    </main>
  );
}
