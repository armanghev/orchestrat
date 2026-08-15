import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AuthCompletionResult } from "./auth-client";
import { useAuthClient, useAuthSnapshot } from "./auth-context";

const recoveryMessage = "We couldn't complete your sign-in.";

type AuthCallbackScreenProps = {
  callbackUrl?: string | null;
  onHandoff?: () => void;
  onRetry?: () => void;
  onSuccess?: (identityKey: string) => void;
};

export function AuthCallbackScreen({ callbackUrl, onHandoff, onRetry, onSuccess }: AuthCallbackScreenProps) {
  const client = useAuthClient();
  const snapshot = useAuthSnapshot();
  const [completionFailed, setCompletionFailed] = useState(false);
  const [completion, setCompletion] = useState<Promise<AuthCompletionResult> | null>(null);
  const completionStarted = useRef(false);
  const callbackForHandoff = callbackUrl === undefined ? window.location.href : callbackUrl;

  useLayoutEffect(() => {
    try {
      if (callbackForHandoff === null) return;
      const callback = new URL(callbackForHandoff);
      if (callback.origin === window.location.origin && callback.pathname === window.location.pathname) {
        window.history.replaceState(window.history.state, "", window.location.pathname);
      }
    } catch { /* The auth client reports a stable invalid-callback error. */ }
  }, [callbackForHandoff]);

  useLayoutEffect(() => {
    if (completionStarted.current || callbackForHandoff === null) return;
    completionStarted.current = true;
    setCompletion(client.completeSignIn(callbackForHandoff));
    onHandoff?.();
  }, [callbackForHandoff, client, onHandoff]);

  useEffect(() => {
    if (!completion) return;
    let active = true;
    void completion.then((result) => {
      if (!active) return;
      if (result.status === "success") onSuccess?.(result.identityKey);
      else if (client.getSnapshot().status !== "error") setCompletionFailed(true);
      setCompletion(null);
    }).catch(() => {
      if (!active) return;
      setCompletionFailed(true);
      setCompletion(null);
    });
    return () => { active = false; };
  }, [client, completion, onSuccess]);

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
