import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import type { SignUpResult } from "./auth-client";
import { AccountForm } from "./account-form";
import { AuthLoading, AuthPage, authLinkClassName } from "./auth-page";
import { SetupScreen } from "./sign-in-screen";
import { useAuthInstance } from "./use-auth-instance";

function SignInLink({ inviteToken }: { inviteToken: string | null }) {
  return (
    <>
      Already have an account?{" "}
      {inviteToken ? (
        // The join page signs in and then accepts the invitation.
        <Link
          to="/project-invitations/join"
          hash={`token=${encodeURIComponent(inviteToken)}`}
          className={authLinkClassName}
        >
          Sign in
        </Link>
      ) : (
        <Link to="/" className={authLinkClassName}>
          Sign in
        </Link>
      )}
    </>
  );
}

export function CreateAccountScreen({
  inviteToken,
  setupToken,
  onPendingChange,
  onSignedUp
}: {
  inviteToken: string | null;
  setupToken?: string;
  onPendingChange?(pending: boolean): void;
  onSignedUp(result: SignUpResult): void;
}) {
  const instance = useAuthInstance();
  if (instance.status === "loading")
    return <AuthLoading label="Loading sign-up" />;
  if (instance.status === "error")
    return (
      <AuthPage
        title="Create your account"
        footer={<SignInLink inviteToken={inviteToken} />}
      >
        <div role="alert" className="rounded-lg border p-3 text-sm">
          <p>We couldn't reach this Orchestrat server.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={instance.reload}
          >
            Retry
          </Button>
        </div>
      </AuthPage>
    );
  const { needs_setup: needsSetup, signup_mode: signupMode } =
    instance.instance;
  if (needsSetup)
    return (
      <SetupScreen
        setupToken={setupToken}
        onRejected={instance.reload}
        onPendingChange={onPendingChange}
        onSignedUp={() => onSignedUp({ invitedProjectId: null })}
      />
    );
  if (signupMode === "closed")
    return (
      <AuthPage
        title="Create your account"
        description="This server doesn't allow new accounts. Ask an admin to create your account."
        footer={<SignInLink inviteToken={inviteToken} />}
      />
    );
  if (signupMode === "invite" && !inviteToken)
    return (
      <AuthPage
        title="Create your account"
        description="This server is invite-only. Ask a teammate for an invite link."
        footer={<SignInLink inviteToken={null} />}
      />
    );
  return (
    <AuthPage
      title="Create your account"
      description={
        inviteToken
          ? "You'll join the project you were invited to."
          : "Create an account on this Orchestrat server."
      }
      footer={<SignInLink inviteToken={inviteToken} />}
    >
      <AccountForm
        mode="signup"
        inviteToken={inviteToken}
        onRejected={instance.reload}
        onPendingChange={onPendingChange}
        onSignedUp={onSignedUp}
      />
    </AuthPage>
  );
}
