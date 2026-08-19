import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parsePublicConfig } from "@/app/config";
import {
  desktopWebCallback,
  githubDesktopAuthUrl,
  parseDesktopAuthRequest,
  sendDesktopMagicLink
} from "@/features/auth/desktop-auth-portal";

function DesktopSignInRoute() {
  const request = parseDesktopAuthRequest(window.location.search);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle"
  );
  if (!request)
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
        <p role="alert" className="text-sm text-destructive">
          This sign-in request is invalid or expired. Return to Orchestrat and
          try again.
        </p>
      </main>
    );

  const config = parsePublicConfig(import.meta.env, "web");
  const callback = desktopWebCallback(window.location.origin, request.flowId);

  function continueWithGitHub() {
    window.location.assign(
      githubDesktopAuthUrl(config.supabaseUrl!, request!, callback)
    );
  }

  async function submitMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "sending") return;
    setStatus("sending");
    try {
      await sendDesktopMagicLink(
        config.supabaseUrl!,
        config.supabasePublishableKey!,
        request!,
        callback,
        email
      );
      setStatus("sent");
    } catch {
      setStatus("error");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 text-center">
      <p className="mb-5 text-sm font-semibold tracking-[0.2em] text-primary-text">
        ORCHESTRAT
      </p>
      <h1 className="text-3xl font-semibold tracking-tight">
        Sign in to the desktop app
      </h1>
      <p className="mt-4 text-sm text-muted-foreground">
        Choose a sign-in method. We’ll return you to Orchestrat automatically.
      </p>

      <div className="mt-8 space-y-5">
        {status === "error" && (
          <p role="alert" className="text-sm text-destructive">
            We couldn’t send the sign-in link. Check the address and try again.
          </p>
        )}
        <Button
          className="w-full"
          type="button"
          aria-label="Continue with GitHub"
          onClick={continueWithGitHub}
        >
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.2c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.95.1-.75.4-1.25.73-1.54-2.57-.3-5.27-1.29-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.14v3.18c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
          </svg>
          <span>GitHub</span>
        </Button>
        <div
          role="separator"
          aria-label="or"
          className="flex items-center gap-3 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground"
        >
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
          <span aria-hidden="true">or</span>
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
        </div>
        {status === "sent" ? (
          <div
            role="status"
            className="rounded-lg border border-border bg-muted/40 p-4 text-left"
          >
            <p className="font-medium text-foreground">Check your email</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Open the sign-in link on this Mac to return to Orchestrat.
            </p>
          </div>
        ) : (
          <form
            className="space-y-3 text-left"
            onSubmit={submitMagicLink}
            noValidate
          >
            <div className="space-y-2">
              <Label htmlFor="desktop-auth-email">Email address</Label>
              <Input
                id="desktop-auth-email"
                type="email"
                autoComplete="email"
                inputMode="email"
                maxLength={254}
                required
                disabled={status === "sending"}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <Button
              className="w-full"
              type="submit"
              variant="outline"
              disabled={status === "sending" || email.length === 0}
            >
              {status === "sending"
                ? "Sending sign-in link…"
                : "Email me a sign-in link"}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}

export const Route = createFileRoute("/auth/desktop")({
  component: DesktopSignInRoute
});
