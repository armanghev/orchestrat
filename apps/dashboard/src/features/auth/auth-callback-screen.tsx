import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AuthClient, AuthCompletionResult } from "./auth-client";
import { useAuthClient, useAuthSnapshot } from "./auth-context";

const recoveryMessage = "We couldn't complete your sign-in.";

type AuthCallbackScreenProps = {
  callbackUrl?: string;
  onRetry?: () => void;
  onSuccess?: (identityKey: string) => void;
};

export function AuthCallbackScreen({ callbackUrl = window.location.href, onRetry, onSuccess }: AuthCallbackScreenProps) {
  const client = useAuthClient();
  const snapshot = useAuthSnapshot();
  const [completionFailed, setCompletionFailed] = useState(false);
  const completion = useRef<{ client: AuthClient; callbackUrl: string; promise: Promise<AuthCompletionResult> } | null>(null);

  useLayoutEffect(() => {
    try {
      const callback = new URL(callbackUrl);
      if (callback.origin === window.location.origin && callback.pathname === window.location.pathname) {
        window.history.replaceState(window.history.state, "", window.location.pathname);
      }
    } catch { /* The auth client reports a stable invalid-callback error. */ }
  }, [callbackUrl]);

  useEffect(() => {
    if (!completion.current || completion.current.client !== client || completion.current.callbackUrl !== callbackUrl) {
      completion.current = { client, callbackUrl, promise: client.completeSignIn(callbackUrl) };
    }
    let active = true;
    void completion.current.promise.then((result) => {
      if (!active) return;
      if (result.status === "success") onSuccess?.(result.identityKey);
      else if (client.getSnapshot().status !== "error") setCompletionFailed(true);
    }).catch(() => {
      if (active) setCompletionFailed(true);
    });
    return () => { active = false; };
  }, [callbackUrl, client, onSuccess]);

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
