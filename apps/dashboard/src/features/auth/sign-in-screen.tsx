import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthClient, useAuthSnapshot } from "./auth-context";

function maskedEmail(value: string): string {
  const separator = value.lastIndexOf("@");
  return separator > 0 ? `•••${value.slice(separator)}` : "•••";
}

export function SignInScreen() {
  const client = useAuthClient();
  const snapshot = useAuthSnapshot();
  const initialEmail = snapshot.status === "sendingMagicLink" || snapshot.status === "magicLinkSent" ? snapshot.email : "";
  const [email, setEmail] = useState(initialEmail);
  const [editingEmail, setEditingEmail] = useState(snapshot.status !== "magicLinkSent");
  const emailInput = useRef<HTMLInputElement>(null);
  const githubPending = snapshot.status === "signingIn";
  const magicPending = snapshot.status === "sendingMagicLink";
  const pending = snapshot.status === "loading" || githubPending || magicPending;
  const invalidEmail = snapshot.status === "error" && snapshot.code === "invalid_email";
  const acceptedEmail = snapshot.status === "magicLinkSent" ? snapshot.email : null;

  useEffect(() => {
    if (acceptedEmail !== null) {
      setEmail(acceptedEmail);
      setEditingEmail(false);
    }
  }, [acceptedEmail]);

  useEffect(() => {
    if (editingEmail && (invalidEmail || email === "")) emailInput.current?.focus();
  }, [editingEmail, email, invalidEmail]);

  function submitMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending) void client.sendMagicLink(email);
  }

  function changeEmail() {
    setEmail("");
    setEditingEmail(true);
  }

  const sentEmail = snapshot.status === "magicLinkSent" ? snapshot.email : initialEmail;

  return <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 text-center">
    <p className="mb-5 text-sm font-semibold tracking-[0.2em] text-primary-text">ORCHESTRAT</p>
    <h1 className="text-3xl font-semibold tracking-tight">Coordinate agents. Keep control.</h1>
    <p className="mt-4 text-sm text-muted-foreground">Sign in securely to continue to the dashboard.</p>

    <div className="mt-8 space-y-5">
      {snapshot.status === "error" && <p role="alert" className="text-sm text-destructive">
        {invalidEmail ? "Enter a valid email address." : "We couldn't sign you in. Try again."}
      </p>}

      {client.capabilities.github && <Button
        className="w-full"
        type="button"
        disabled={pending}
        onClick={() => { void client.signInWithGitHub(); }}
      >{githubPending ? "Connecting to GitHub…" : "Continue with GitHub"}</Button>}

      {client.capabilities.github && client.capabilities.magicLink && <div
        role="separator"
        aria-label="or"
        className="flex items-center gap-3 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground"
      >
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        <span aria-hidden="true">or</span>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </div>}

      {client.capabilities.magicLink && snapshot.status === "magicLinkSent" && !editingEmail ? <div
        role="status"
        className="rounded-lg border border-border bg-muted/40 p-4 text-left"
      >
        <p className="font-medium text-foreground">Check your email</p>
        <p className="mt-1 text-sm text-muted-foreground">A sign-in link was accepted for {maskedEmail(sentEmail)}. Delivery may take a moment.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => { void client.sendMagicLink(sentEmail); }}>Send again</Button>
          <Button type="button" size="sm" variant="ghost" onClick={changeEmail}>Use a different email</Button>
        </div>
      </div> : client.capabilities.magicLink && <form className="space-y-3 text-left" onSubmit={submitMagicLink} noValidate>
        <div className="space-y-2">
          <Label htmlFor="auth-email">Email address</Label>
          <Input
            ref={emailInput}
            id="auth-email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            maxLength={254}
            required
            disabled={magicPending}
            aria-invalid={invalidEmail || undefined}
            aria-describedby={invalidEmail ? "auth-email-error" : undefined}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          {invalidEmail && <p id="auth-email-error" className="text-xs text-destructive">Use an address such as name@example.com.</p>}
        </div>
        <Button className="w-full" type="submit" variant="outline" disabled={pending || email.length === 0}>
          {magicPending ? "Sending sign-in link…" : "Email me a sign-in link"}
        </Button>
      </form>}
    </div>
  </main>;
}
