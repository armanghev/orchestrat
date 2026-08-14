import { useEffect, useRef } from "react";
import { useAuthClient, useAuthSnapshot } from "./auth-context";

export function AuthCallbackScreen() {
  const client = useAuthClient();
  const snapshot = useAuthSnapshot();
  const completed = useRef(false);

  useEffect(() => {
    if (completed.current) return;
    completed.current = true;
    void client.completeSignIn(window.location.href);
  }, [client]);

  if (snapshot.status === "error") {
    return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
      <p role="alert" className="text-sm text-destructive">{snapshot.message}</p>
      <a className="mt-4 text-sm text-primary underline" href="/">Try again</a>
    </main>;
  }

  return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
    <p role="status" className="text-sm text-muted-foreground">Completing sign-in…</p>
  </main>;
}
