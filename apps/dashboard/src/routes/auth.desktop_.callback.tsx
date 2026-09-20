import { useLayoutEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { desktopAppCallback } from "@/features/auth/desktop-auth-portal";

function DesktopCallbackRoute() {
  const [callback] = useState(() =>
    desktopAppCallback(
      window.location.search,
      import.meta.env.DEV && import.meta.env.VITE_DESKTOP_DEV === "1"
    )
  );

  useLayoutEffect(() => {
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname
    );
    if (callback) window.location.replace(callback);
  }, [callback]);

  if (!callback)
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
        <p role="alert" className="text-sm text-destructive">
          We couldn’t return this sign-in to Orchestrat. Return to the app and
          try again.
        </p>
      </main>
    );

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
      <p role="status" className="text-sm text-muted-foreground">
        Returning to Orchestrat…
      </p>
      <a className="mt-4 text-sm text-primary underline" href={callback}>
        Open Orchestrat
      </a>
    </main>
  );
}

export const Route = createFileRoute("/auth/desktop_/callback")({
  component: DesktopCallbackRoute
});
