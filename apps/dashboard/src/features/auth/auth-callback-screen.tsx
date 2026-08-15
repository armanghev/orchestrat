import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuthClient, useAuthSnapshot } from "./auth-context";

const recoveryMessage = "We couldn't complete your sign-in.";

type AuthCallbackScreenProps = {
  callbackUrl?: string;
  onRetry?: () => void;
};

export function AuthCallbackScreen({ callbackUrl = window.location.href, onRetry }: AuthCallbackScreenProps) {
  const client = useAuthClient();
  const snapshot = useAuthSnapshot();
  const [completionFailed, setCompletionFailed] = useState(false);
  const completionStarted = useRef(false);

  useLayoutEffect(() => {
    try {
      const callback = new URL(callbackUrl);
      if (callback.origin === window.location.origin && callback.pathname === window.location.pathname) {
        window.history.replaceState(window.history.state, "", window.location.pathname);
      }
    } catch { /* The auth client reports a stable invalid-callback error. */ }
  }, [callbackUrl]);

  useEffect(() => {
    if (completionStarted.current) return;
    completionStarted.current = true;
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
