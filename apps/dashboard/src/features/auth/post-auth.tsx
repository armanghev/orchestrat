import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  clearStoredInvitationToken,
  projectInvitationTokenPattern,
  storedInvitationToken
} from "@/features/settings/project-invitation-token";

// A CLI approval link opened while signed out waits here until sign-in.
export const CLI_ATTEMPT_KEY = "orchestrat.cli.authorization.attempt";
export const cliAttemptPattern = /^ca_[A-Za-z0-9_-]{20,}$/;

export type PostAuthDestination =
  | { kind: "cli"; attempt: string }
  | { kind: "invitation"; token: string }
  | { kind: "project"; projectId: string }
  | { kind: "home" };

function takeCliAttempt(): string | null {
  try {
    const attempt = window.sessionStorage.getItem(CLI_ATTEMPT_KEY);
    window.sessionStorage.removeItem(CLI_ATTEMPT_KEY);
    return attempt && cliAttemptPattern.test(attempt) ? attempt : null;
  } catch {
    return null;
  }
}

/**
 * Where to go right after signing in: a pending CLI approval, then a pending
 * project invitation, else the normal landing. Reading it consumes it.
 */
export function takePostAuthDestination(): PostAuthDestination {
  const attempt = takeCliAttempt();
  if (attempt) return { kind: "cli", attempt };
  const token = storedInvitationToken();
  clearStoredInvitationToken();
  if (token && projectInvitationTokenPattern.test(token))
    return { kind: "invitation", token };
  return { kind: "home" };
}

export function usePostAuthNavigate() {
  const navigate = useNavigate();
  return (destination: PostAuthDestination) => {
    switch (destination.kind) {
      case "cli":
        return navigate({
          to: "/cli/authorize",
          search: { attempt: destination.attempt },
          replace: true
        });
      case "invitation":
        return navigate({
          to: "/project-invitations/join",
          hash: `token=${encodeURIComponent(destination.token)}`,
          replace: true
        });
      case "project":
        return navigate({
          to: "/projects/$projectId/overview",
          params: { projectId: destination.projectId },
          replace: true
        });
      default:
        return navigate({ to: "/onboarding", replace: true });
    }
  };
}

/** Rendered by a signed-in auth page: leaves for the right place once. */
export function PostAuthRedirect() {
  const navigateTo = usePostAuthNavigate();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void navigateTo(takePostAuthDestination());
  }, [navigateTo]);
  return (
    <main className="flex min-h-dvh items-center justify-center">
      <p role="status" className="text-sm text-muted-foreground">
        Signing in…
      </p>
    </main>
  );
}
