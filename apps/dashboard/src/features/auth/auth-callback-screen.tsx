import { useEffect, useRef, useState } from "react";
import { useAuthClient, useAuthSnapshot } from "./auth-context";

const recoveryMessage = "We couldn't complete your sign-in.";

type AuthCallbackScreenProps = {
  callbackUrl?: string;
  onRetry?: () => void;
};

export function AuthCallbackScreen({ callbackUrl = window.location.href, onRetry }: AuthCallbackScreenProps) {
  const client = useAuthClient();
  const snapshot = useAuthSnapshot();
  const completed = useRef(false);
  const [completionFailed, setCompletionFailed] = useState(false);

  useEffect(() => {
    if (completed.current) return;
    completed.current = true;
    let active = true;
    void client.completeSignIn(callbackUrl).catch(() => {
      if (active) setCompletionFailed(true);
    });
    return () => { active = false; };
  }, [callbackUrl, client]);

  if (completionFailed || snapshot.status === "error") {
    return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
      <p role="alert" className="text-sm text-destructive">{recoveryMessage}</p>
      {onRetry
        ? <button type="button" className="mt-4 text-sm text-primary underline" onClick={onRetry}>Try again</button>
        : <a className="mt-4 text-sm text-primary underline" href="/">Try again</a>}
    </main>;
  }

  return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
    <p role="status" className="text-sm text-muted-foreground">Completing sign-in…</p>
  </main>;
}
