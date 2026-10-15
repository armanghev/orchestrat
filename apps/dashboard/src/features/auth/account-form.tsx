import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { SignUpResult } from "./auth-client";
import { useAuthClient } from "./auth-context";
import {
  authErrorMessage,
  errorCode,
  fullNameProblem,
  newPasswordProblem,
  FULL_NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH
} from "./auth-errors";
import { AuthField, useFieldFocus } from "./auth-page";
import { normalizeAuthEmail } from "./email";

type Errors = {
  setupToken?: string;
  name?: string;
  email?: string;
  password?: string;
  confirm?: string;
  form?: string;
};

const fieldOrder = [
  "setupToken",
  "name",
  "email",
  "password",
  "confirm"
] as const;

const ids = {
  setupToken: "account-setup-token",
  name: "account-name",
  email: "account-email",
  password: "account-password",
  confirm: "account-confirm-password"
} as const;

/**
 * Name, email and password for a new account. `setup` creates the server's
 * first (admin) account and needs the setup token from the server log.
 */
export function AccountForm({
  mode,
  inviteToken,
  initialSetupToken,
  onRejected,
  onPendingChange,
  onSignedUp
}: {
  mode: "setup" | "signup";
  inviteToken?: string | null;
  initialSetupToken?: string;
  /** The server's signup rules changed under us; refetch them. */
  onRejected?(): void;
  onPendingChange?(pending: boolean): void;
  onSignedUp?(result: SignUpResult): void;
}) {
  const client = useAuthClient();
  const [setupToken, setSetupToken] = useState(initialSetupToken ?? "");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const focusField = useFieldFocus();

  function showErrors(next: Errors) {
    setErrors(next);
    const first = fieldOrder.find((field) => next[field]);
    if (first) focusField(ids[first]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const normalizedEmail = normalizeAuthEmail(email);
    const problems: Errors = {
      setupToken:
        mode === "setup" && setupToken.trim().length === 0
          ? "Enter the setup token from the server log."
          : undefined,
      name: fullNameProblem(name) ?? undefined,
      email: normalizedEmail ? undefined : "Enter a valid email address.",
      password: newPasswordProblem(password) ?? undefined,
      confirm: confirm === password ? undefined : "The passwords don't match."
    };
    if (fieldOrder.some((field) => problems[field])) {
      showErrors(problems);
      return;
    }
    setErrors({});
    setPending(true);
    onPendingChange?.(true);
    try {
      const result = await client.signUp({
        email: normalizedEmail!,
        password,
        fullName: name.trim(),
        inviteToken: inviteToken ?? undefined,
        setupToken: mode === "setup" ? setupToken.trim() : undefined
      });
      onSignedUp?.(result);
    } catch (error) {
      setPending(false);
      onPendingChange?.(false);
      const code = errorCode(error);
      if (code === "EMAIL_TAKEN")
        return showErrors({
          email: "An account with this email already exists. Sign in instead."
        });
      if (code === "SETUP_TOKEN_REQUIRED") {
        if (mode === "setup")
          return showErrors({
            setupToken:
              "This setup token is missing or wrong. Copy it from the server log."
          });
        onRejected?.();
      }
      if (
        mode === "setup" &&
        (code === "INVITE_REQUIRED" || code === "SIGNUP_CLOSED")
      ) {
        // Someone else finished setup first; show the normal rules.
        onRejected?.();
        return;
      }
      showErrors({
        form:
          code === "INVITE_REQUIRED" && inviteToken
            ? "This invite link is invalid or has expired. Ask a teammate for a new one."
            : authErrorMessage(error, mode === "setup" ? "setup" : "signUp")
      });
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={submit}
      noValidate
      aria-busy={pending}
    >
      {mode === "setup" ? (
        <AuthField
          id={ids.setupToken}
          label="Setup token"
          name="setup_token"
          autoComplete="off"
          spellCheck={false}
          maxLength={512}
          required
          className="font-mono"
          hint="Printed in the server log at startup, or set with ORCHESTRAT_SETUP_TOKEN."
          value={setupToken}
          error={errors.setupToken}
          disabled={pending}
          onChange={(event) => setSetupToken(event.target.value)}
        />
      ) : null}
      <AuthField
        id={ids.name}
        label="Name"
        name="name"
        autoComplete="name"
        maxLength={FULL_NAME_MAX_LENGTH}
        required
        value={name}
        error={errors.name}
        disabled={pending}
        onChange={(event) => setName(event.target.value)}
      />
      <AuthField
        id={ids.email}
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
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
        name="new-password"
        autoComplete="new-password"
        maxLength={PASSWORD_MAX_LENGTH}
        required
        hint="At least 10 characters."
        value={password}
        error={errors.password}
        disabled={pending}
        onChange={(event) => setPassword(event.target.value)}
      />
      <AuthField
        id={ids.confirm}
        label="Confirm password"
        type="password"
        name="confirm-password"
        autoComplete="new-password"
        maxLength={PASSWORD_MAX_LENGTH}
        required
        value={confirm}
        error={errors.confirm}
        disabled={pending}
        onChange={(event) => setConfirm(event.target.value)}
      />
      {errors.form ? (
        <p role="alert" className="text-sm text-destructive">
          {errors.form}
        </p>
      ) : null}
      <Button className="w-full" type="submit" disabled={pending}>
        {pending
          ? "Creating account…"
          : mode === "setup"
            ? "Create admin account"
            : "Create account"}
      </Button>
    </form>
  );
}
