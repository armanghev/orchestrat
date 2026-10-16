import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { useAuthSnapshot } from "@/features/auth/auth-context";
import { CreateAccountScreen } from "@/features/auth/create-account-screen";
import {
  PostAuthRedirect,
  takePostAuthDestination,
  usePostAuthNavigate
} from "@/features/auth/post-auth";
import {
  clearStoredInvitationToken,
  projectInvitationTokenPattern,
  storeInvitationToken,
  storedInvitationToken
} from "@/features/settings/project-invitation-token";

function SignupRoute() {
  const snapshot = useAuthSnapshot();
  const search = Route.useSearch();
  const navigateTo = usePostAuthNavigate();
  // Keeps the form on screen while a signup it started finishes.
  const [submitting, setSubmitting] = useState(false);
  const inviteToken =
    search.invite && projectInvitationTokenPattern.test(search.invite)
      ? search.invite
      : storedInvitationToken();

  useEffect(() => {
    if (inviteToken && snapshot.status === "signedOut")
      storeInvitationToken(inviteToken);
  }, [inviteToken, snapshot.status]);

  if (snapshot.status === "loading")
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p role="status" aria-label="Restoring session…">
          Restoring session…
        </p>
      </main>
    );
  if (snapshot.status === "signedIn" && !submitting)
    return <PostAuthRedirect />;
  return (
    <CreateAccountScreen
      inviteToken={inviteToken}
      setupToken={search.setup_token}
      onPendingChange={setSubmitting}
      onSignedUp={({ invitedProjectId }) => {
        // The server already accepted the invite with the signup.
        if (invitedProjectId) {
          clearStoredInvitationToken();
          void navigateTo({ kind: "project", projectId: invitedProjectId });
        } else void navigateTo(takePostAuthDestination());
      }}
    />
  );
}

export const Route = createFileRoute("/signup")({
  validateSearch: z.object({
    invite: z.string().max(512).optional().catch(undefined),
    setup_token: z.string().max(512).optional().catch(undefined)
  }),
  component: SignupRoute
});
