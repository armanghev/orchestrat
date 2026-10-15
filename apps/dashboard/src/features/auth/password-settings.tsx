import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  authErrorMessage,
  errorCode,
  newPasswordProblem,
  PASSWORD_MAX_LENGTH
} from "./auth-errors";
import { AuthField, useFieldFocus } from "./auth-page";

const ids = {
  current: "password-current",
  next: "password-new",
  confirm: "password-confirm"
} as const;

type Errors = {
  current?: string;
  next?: string;
  confirm?: string;
  form?: string;
};

export function PasswordCard({
  email,
  onChangePassword
}: {
  email: string;
  onChangePassword(current: string, next: string): Promise<void>;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [saved, setSaved] = useState(false);
  const focusField = useFieldFocus();

  function showErrors(value: Errors) {
    setErrors(value);
    const first = (["current", "next", "confirm"] as const).find(
      (field) => value[field]
    );
    if (first) focusField(ids[first]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setSaved(false);
    const problems: Errors = {
      current: current ? undefined : "Enter your current password.",
      next: newPasswordProblem(next) ?? undefined,
      confirm: confirm === next ? undefined : "The passwords don't match."
    };
    if (problems.current || problems.next || problems.confirm)
      return showErrors(problems);
    setErrors({});
    setPending(true);
    try {
      await onChangePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setSaved(true);
    } catch (error) {
      if (errorCode(error) === "PASSWORD_INCORRECT")
        showErrors({ current: "Your current password is incorrect." });
      else showErrors({ form: authErrorMessage(error, "password") });
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="mt-6" aria-labelledby="password-heading">
      <CardHeader>
        <CardTitle>
          <h2 id="password-heading" className="font-medium">
            Password
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="max-w-sm space-y-4"
          onSubmit={submit}
          noValidate
          aria-busy={pending}
        >
          {/* Lets password managers match the change to the account. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            value={email}
            hidden
            readOnly
          />
          <AuthField
            id={ids.current}
            label="Current password"
            type="password"
            autoComplete="current-password"
            maxLength={PASSWORD_MAX_LENGTH}
            value={current}
            error={errors.current}
            disabled={pending}
            onChange={(event) => setCurrent(event.target.value)}
          />
          <AuthField
            id={ids.next}
            label="New password"
            type="password"
            autoComplete="new-password"
            maxLength={PASSWORD_MAX_LENGTH}
            hint="At least 10 characters."
            value={next}
            error={errors.next}
            disabled={pending}
            onChange={(event) => setNext(event.target.value)}
          />
          <AuthField
            id={ids.confirm}
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            maxLength={PASSWORD_MAX_LENGTH}
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
          {saved ? (
            <p role="status" className="text-sm text-muted-foreground">
              Password changed. Your other sessions were signed out.
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Changing password…" : "Change password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function SessionsCard({
  onSignOut,
  onSignOutEverywhere
}: {
  onSignOut(): void | Promise<void>;
  onSignOutEverywhere(): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOutEverywhere() {
    setPending(true);
    setError(null);
    try {
      await onSignOutEverywhere();
    } catch (cause) {
      setError(authErrorMessage(cause, "session"));
      setPending(false);
    }
  }

  return (
    <Card className="mt-6" aria-labelledby="profile-session-heading">
      <CardHeader>
        <CardTitle>
          <h2 id="profile-session-heading" className="font-medium">
            Sessions
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Sign out everywhere ends every session for your account, on every
          device, including this one.
        </p>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => void onSignOut()}
          >
            Sign out
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void signOutEverywhere()}
          >
            {pending ? "Signing out everywhere…" : "Sign out everywhere"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
