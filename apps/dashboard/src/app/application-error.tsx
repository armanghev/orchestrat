import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { DashboardApiError } from "@/lib/api/client";
import { defaultPreferences } from "@/platform/preferences";

export function ApplicationError({
  error
}: {
  error: unknown;
  reset: () => void;
}) {
  const router = useRouter();
  const [resetMessage, setResetMessage] = useState<string | null>(null);
  const reference = error instanceof DashboardApiError ? error.requestId : null;

  const resetLocalView = async () => {
    setResetMessage(null);
    try {
      await router.options.context.platform.preferences.save(
        defaultPreferences
      );
      localStorage.removeItem("orchestrat.theme");
      window.location.reload();
    } catch {
      setResetMessage("Local view could not be reset. Please try again.");
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">
        Something went wrong
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        The dashboard could not be displayed.
      </p>
      {reference ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Reference: {reference}
        </p>
      ) : null}
      {resetMessage ? (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {resetMessage}
        </p>
      ) : null}
      <div className="mt-8 flex justify-center gap-3">
        <Button onClick={() => window.location.reload()}>Reload</Button>
        <Button
          variant="outline"
          onClick={() => {
            void resetLocalView();
          }}
        >
          Reset local view
        </Button>
      </div>
    </main>
  );
}
