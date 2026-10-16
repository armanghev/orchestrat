import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { pendingRepositoryAuthorizationResponseSchema } from "@orchestrat/protocol";
import { DashboardApiError, type ApiClient } from "@/lib/api/client";
import { goTo } from "./redirect";
import {
  REPOSITORY_ATTEMPT_KEY,
  authorizationPattern
} from "./repository-copy";

const attemptSchema = z.object({
  return_path: pendingRepositoryAuthorizationResponseSchema.shape.return_path,
  authorization_id: z.string().regex(authorizationPattern),
  /** A project's attempt, or an organization integration's. */
  project_id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid().nullable().optional(),
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

// GitHub's Setup URL lands here after an app install. Its installation_id is
// untrusted: the API accepts it only when the authorizing user's token lists
// that installation. The attempt comes from this tab, or from the server when
// the install opened in another browser (the desktop app sends people to their
// own browser).
export function GithubSetup({
  api,
  installationId
}: {
  api: ApiClient;
  installationId?: string;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // undefined while the server is asked; null when there's none.
  const [attempt, setAttempt] = useState<Attempt | null | undefined>(
    () => readGithubAttempt() ?? undefined
  );
  const started = useRef(false);
  const validInstallation = /^[1-9][0-9]{0,19}$/.test(installationId ?? "");
  useEffect(() => {
    if (attempt !== undefined) return;
    let active = true;
    api
      .getPendingRepositoryAuthorization("github")
      .then((pending) => {
        if (active)
          setAttempt({
            authorization_id: pending.authorization_id,
            project_id: pending.project_id,
            organization_id: pending.organization_id ?? null,
            return_path: pending.return_path,
            provider: "github"
          });
      })
      .catch(() => {
        if (active) setAttempt(null);
      });
    return () => {
      active = false;
    };
  }, [api, attempt]);
  useEffect(() => {
    if (started.current || !attempt || !validInstallation) return;
    started.current = true;
    // An organization integration: the installation becomes the integration.
    if (attempt.organization_id) {
      const organizationId = attempt.organization_id;
      void api
        .createOrganizationIntegration(organizationId, {
          provider: "github",
          authorization_id: attempt.authorization_id,
          installation_id: installationId!
        })
        .then(() => {
          window.sessionStorage.removeItem(REPOSITORY_ATTEMPT_KEY);
          const target = new URL(
            attempt.return_path ??
              `/organizations/${organizationId}/integrations`,
            window.location.origin
          );
          void navigate({
            href: `${target.pathname}${target.search}`,
            replace: true
          });
        })
        .catch(() => {
          window.sessionStorage.removeItem(REPOSITORY_ATTEMPT_KEY);
          setError(
            "We couldn’t connect this GitHub installation. Start again from the organization’s Integrations."
          );
        });
      return;
    }
    if (!attempt.project_id) return;
    const projectId = attempt.project_id;
    void api
      .submitGithubInstallation(
        projectId,
        attempt.authorization_id,
        installationId!
      )
      .then((result) => {
        if (result.next === "authorize") {
          goTo(result.authorize_url);
          return;
        }
        window.sessionStorage.removeItem(REPOSITORY_ATTEMPT_KEY);
        const target = new URL(
          result.return_path ??
            attempt.return_path ??
            `/projects/${projectId}/settings`,
          window.location.origin
        );
        target.searchParams.set(
          "repository_authorization",
          attempt.authorization_id
        );
        void navigate({
          href: `${target.pathname}${target.search}`,
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
    (attempt === null
      ? "There’s no GitHub connection in progress for your account, or it expired. Start again from the project’s settings."
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
          {attempt?.organization_id ? (
            <Link
              to="/organizations/$organizationId/integrations"
              params={{ organizationId: attempt.organization_id }}
              className="mt-6 w-fit text-sm font-medium underline"
            >
              Back to integrations
            </Link>
          ) : attempt?.project_id ? (
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
