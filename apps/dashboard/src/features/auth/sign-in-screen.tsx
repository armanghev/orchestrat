import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import type { SignupMode } from "@orchestrat/protocol";
import { AccountForm } from "./account-form";
import { useAuthClient } from "./auth-context";
import { authErrorMessage } from "./auth-errors";
import {
  AuthField,
  AuthLoading,
  AuthPage,
  authLinkClassName,
  useFieldFocus
} from "./auth-page";
import { normalizeAuthEmail } from "./email";
import { useAuthInstance } from "./use-auth-instance";

type SignInScreenProps = {
  /** A project invitation the person is signing in to accept. */
  inviteToken?: string | null;
  /** From `?setup_token=`; prefills first-run setup. */
  setupToken?: string;
};

/**
 * Signed-out entry point. On a server with no accounts yet it becomes
 * first-run setup, which creates the admin account.
 */
export function SignInScreen({ inviteToken, setupToken }: SignInScreenProps) {
  const instance = useAuthInstance();
  if (instance.status === "loading")
    return <AuthLoading label="Loading sign-in" />;
  if (instance.status === "ready" && instance.instance.needs_setup)
    return <SetupScreen setupToken={setupToken} onRejected={instance.reload} />;
  return (
    <SignInForm
      inviteToken={inviteToken ?? null}
      signupMode={
        instance.status === "ready" ? instance.instance.signup_mode : null
      }
      unreachable={instance.status === "error"}
      onRetry={instance.reload}
    />
  );
}

export function SetupScreen({
  setupToken,
  onRejected,
  onPendingChange,
  onSignedUp
}: {
  setupToken?: string;
  onRejected(): void;
  onPendingChange?(pending: boolean): void;
  onSignedUp?(): void;
}) {
  return (
    <AuthPage
      title="Set up this Orchestrat server"
      description="Create the first account. It becomes the admin for this server."
    >
      <AccountForm
        mode="setup"
        initialSetupToken={setupToken}
        onRejected={onRejected}
        onPendingChange={onPendingChange}
        onSignedUp={onSignedUp ? () => onSignedUp() : undefined}
      />
    </AuthPage>
  );
}

const ids = { email: "sign-in-email", password: "sign-in-password" };

function SignInForm({
  inviteToken,
  signupMode,
  unreachable,
  onRetry
}: {
  inviteToken: string | null;
  signupMode: SignupMode | null;
  unreachable: boolean;
  onRetry(): void;
}) {
  const client = useAuthClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<{
    email?: string;
    password?: string;
    form?: string;
  }>({});
  const focusField = useFieldFocus();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const normalized = normalizeAuthEmail(email);
    const problems = {
      email: normalized ? undefined : "Enter a valid email address.",
      password: password.length > 0 ? undefined : "Enter your password."
    };
    if (problems.email || problems.password) {
      setErrors(problems);
      focusField(problems.email ? ids.email : ids.password);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      await client.signIn(normalized!, password);
    } catch (error) {
      setErrors({ form: authErrorMessage(error, "signIn") });
      setPending(false);
    }
  }

  let footer: ReactNode = null;
  if (signupMode === "closed" && !inviteToken)
    footer = "Need an account? Ask an admin to create your account.";
  else if (signupMode !== null || inviteToken)
    footer = (
      <>
        New here?{" "}
        <Link
          to="/signup"
          search={inviteToken ? { invite: inviteToken } : {}}
          className={authLinkClassName}
        >
          Create an account
        </Link>
      </>
    );

  return (
    <AuthPage
      title="Sign in to Orchestrat"
      description={
        inviteToken
          ? "Sign in or create an account to join the project."
          : "Use the email and password for your account on this server."
      }
      footer={footer}
    >
      {unreachable ? (
        <div role="alert" className="mb-5 rounded-lg border p-3 text-sm">
          <p>We couldn't reach this Orchestrat server.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={onRetry}
          >
            Retry
          </Button>
        </div>
      ) : null}
      <form
        className="space-y-4"
        onSubmit={submit}
        noValidate
        aria-busy={pending}
      >
        <AuthField
          id={ids.email}
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          maxLength={254}
          required
          value={email}
          error={errors.email}
          disabled={pending}
          onChange={(event) => setEmail(event.target.value)}
        />
        <AuthField
          id={ids.password}
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          maxLength={256}
          required
          value={password}
          error={errors.password}
          disabled={pending}
          onChange={(event) => setPassword(event.target.value)}
        />
        {errors.form ? (
          <p role="alert" className="text-sm text-destructive">
            {errors.form}
          </p>
        ) : null}
        <Button className="w-full" type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthPage>
  );
}
