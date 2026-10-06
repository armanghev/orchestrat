import { useEffect, useState } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { PublicConfig } from "@/app/config";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/features/auth/auth-provider";
import {
  loadingAuthClient,
  type AuthClient
} from "@/features/auth/auth-client";
import { useAuthClient } from "@/features/auth/auth-context";
import { ApiClient } from "@/lib/api/client";
import type {
  NativeNotificationDestination,
  Platform
} from "@/platform/contract";
import { PlatformProvider, usePlatform } from "@/platform/provider";
import { PreferencesProvider } from "@/platform/preferences-provider";
import { ThemeProvider } from "@/features/theme/theme-provider";
import { createDashboardQueryClient } from "./query-client";
import { createAppRouter } from "./router";

export function watchAuthSessionBoundaries(
  auth: Pick<AuthClient, "getSnapshot" | "subscribe">,
  queryClient: Pick<QueryClient, "clear">,
  router: { navigate(options: { to: "/"; replace?: boolean }): unknown }
): () => void {
  const initial = auth.getSnapshot();
  let previousStatus = initial.status;
  let activeIdentity =
    initial.status === "signedIn" ? initial.identityKey : null;
  return auth.subscribe(() => {
    const snapshot = auth.getSnapshot();
    if (snapshot.status === "signedIn") {
      if (activeIdentity !== null && activeIdentity !== snapshot.identityKey) {
        queryClient.clear();
        void router.navigate({ to: "/", replace: true });
      }
      activeIdentity = snapshot.identityKey;
    } else if (snapshot.status === "signedOut") {
      if (activeIdentity !== null) queryClient.clear();
      activeIdentity = null;
      if (previousStatus !== "signedOut") void router.navigate({ to: "/" });
    }
    previousStatus = snapshot.status;
  });
}

// `branch` is the destination's branch; without one the page shows the
// default branch (docs/project-branches.md §11.1).
type NotificationNavigation =
  | {
      to: "/projects/$projectId/tasks";
      params: { projectId: string };
      search: { task: string; branch: string | undefined };
    }
  | {
      to: "/projects/$projectId/activity";
      params: { projectId: string };
      search: { branch: string | undefined };
    }
  | {
      to: "/projects/$projectId/messages";
      params: { projectId: string };
      search: { chat: string; branch: string | undefined };
    };

export function watchNotificationActions(
  platform: Pick<Platform, "onNotificationAction">,
  router: { navigate(options: NotificationNavigation): unknown }
) {
  if (!platform.onNotificationAction) return () => undefined;
  let active = true;
  let unsubscribe: (() => void) | undefined;
  void platform
    .onNotificationAction((destination: NativeNotificationDestination) => {
      if (!active) return;
      const branch = destination.branchId;
      if (destination.kind === "task") {
        void router.navigate({
          to: "/projects/$projectId/tasks",
          params: { projectId: destination.projectId },
          search: { task: destination.taskId, branch }
        });
      } else {
        if (destination.kind === "chat") {
          void router.navigate({
            to: "/projects/$projectId/messages",
            params: { projectId: destination.projectId },
            search: { chat: destination.chatId, branch }
          });
        } else {
          void router.navigate({
            to: "/projects/$projectId/activity",
            params: { projectId: destination.projectId },
            search: { branch }
          });
        }
      }
    })
    .then((stop) => {
      if (active) unsubscribe = stop;
      else stop();
    })
    .catch(() => {
      // Notification click delivery is best effort and must not disrupt the app shell.
    });
  return () => {
    active = false;
    unsubscribe?.();
  };
}

function RouterRuntime({ config }: { config: PublicConfig }) {
  const auth = useAuthClient();
  const platform = usePlatform();
  const [queryClient] = useState(createDashboardQueryClient);
  const [api] = useState(() => new ApiClient(config.apiUrl, auth));
  const [router] = useState(() =>
    createAppRouter({ api, auth, platform, queryClient })
  );

  useEffect(
    () => watchAuthSessionBoundaries(auth, queryClient, router),
    [auth, queryClient, router]
  );
  useEffect(
    () => watchNotificationActions(platform, router),
    [platform, router]
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider
          router={router}
          context={{ api, auth, platform, queryClient }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function AuthBoundary({ config }: { config: PublicConfig }) {
  const auth = useAuthClient();
  // Do not build API or router objects around AuthProvider's temporary client.
  if (auth === loadingAuthClient) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p role="status" aria-label="Restoring session…">
          Restoring session…
        </p>
      </main>
    );
  }
  return <RouterRuntime config={config} />;
}

function ProviderGraph({ config }: { config: PublicConfig }) {
  const platform = usePlatform();
  return (
    <AuthProvider config={config} platform={platform}>
      <AuthBoundary config={config} />
    </AuthProvider>
  );
}

export function AppProviders({ config }: { config: PublicConfig }) {
  return (
    <PlatformProvider>
      <PreferencesProvider>
        <ThemeProvider>
          <ProviderGraph config={config} />
        </ThemeProvider>
      </PreferencesProvider>
    </PlatformProvider>
  );
}
