import { useEffect, useState } from "react";
import {
  createFileRoute,
  useLocation,
  useNavigate,
  useRouter
} from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useAuthSnapshot } from "@/features/auth/auth-context";
import { SignInScreen } from "@/features/auth/sign-in-screen";
import {
  clearStoredInvitationToken,
  invitationTokenFromHash,
  storeInvitationToken,
  storedInvitationToken
} from "@/features/settings/project-invitation-token";
import { hierarchyKeys } from "@/features/hierarchy/query-options";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unable to join this project.";

function ProjectInvitationJoinRoute() {
  const auth = useAuthSnapshot();
  const location = useLocation();
  const router = useRouter();
  const navigate = useNavigate();
  const token =
    invitationTokenFromHash(location.hash) ?? storedInvitationToken();
  const [status, setStatus] = useState<"idle" | "joining" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const identityKey = auth.status === "signedIn" ? auth.identityKey : null;

  useEffect(() => {
    if (auth.status === "signedOut" && token) storeInvitationToken(token);
  }, [auth.status, token]);

  useEffect(() => {
    if (!token || auth.status !== "signedIn") return;
    let active = true;
    setStatus("joining");
    void (async () => {
      try {
        const { project } =
          await router.options.context.api.acceptProjectInvitation(token);
        if (!active) return;
        clearStoredInvitationToken();
        await router.options.context.queryClient.invalidateQueries({
          queryKey: hierarchyKeys.all
        });
        await router.invalidate();
        void navigate({
          to: "/projects/$projectId/overview",
          params: { projectId: project.id },
          replace: true
        });
      } catch (cause) {
        if (!active) return;
        setError(errorMessage(cause));
        setStatus("error");
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt, auth.status, identityKey, navigate, router, token]);

  if (!token)
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Invitation unavailable
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          This invitation link is invalid or incomplete.
        </p>
      </main>
    );

  if (auth.status === "signedOut") return <SignInScreen inviteToken={token} />;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
      <p className="text-sm font-semibold tracking-[0.2em] text-primary-text">
        ORCHESTRAT
      </p>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">
        Join project
      </h1>
      {status === "error" ? (
        <>
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
          <Button
            className="mt-5 self-center"
            onClick={() => {
              setError(null);
              setStatus("idle");
              setAttempt((current) => current + 1);
            }}
          >
            Try again
          </Button>
        </>
      ) : (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {auth.status === "loading"
            ? "Restoring session…"
            : "Joining project…"}
        </p>
      )}
    </main>
  );
}

export const Route = createFileRoute("/project-invitations/join")({
  component: ProjectInvitationJoinRoute
});
