import { useEffect, useState } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { PublicConfig } from "@/app/config";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/features/auth/auth-provider";
import { loadingAuthClient, type AuthClient } from "@/features/auth/auth-client";
import { useAuthClient } from "@/features/auth/auth-context";
import { ApiClient } from "@/lib/api/client";
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
  let activeIdentity = initial.status === "signedIn" ? initial.identityKey : null;
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

function RouterRuntime({ config }: { config: PublicConfig }) {
  const auth = useAuthClient();
  const platform = usePlatform();
  const [queryClient] = useState(createDashboardQueryClient);
  const [api] = useState(() => new ApiClient(config.apiUrl, auth));
  const [router] = useState(() => createAppRouter({ api, auth, platform, queryClient }));

  useEffect(() => watchAuthSessionBoundaries(auth, queryClient, router), [auth, queryClient, router]);

  return <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <RouterProvider router={router} context={{ api, auth, platform, queryClient }} />
    </TooltipProvider>
  </QueryClientProvider>;
}

function AuthBoundary({ config }: { config: PublicConfig }) {
  const auth = useAuthClient();
  // Do not build API or router objects around AuthProvider's temporary client.
  if (auth === loadingAuthClient) {
    return <main className="flex min-h-screen items-center justify-center"><p role="status" aria-label="Restoring session…">Restoring session…</p></main>;
  }
  return <RouterRuntime config={config} />;
}

function ProviderGraph({ config }: { config: PublicConfig }) {
  const platform = usePlatform();
  return <AuthProvider config={config} platform={platform}><AuthBoundary config={config} /></AuthProvider>;
}

export function AppProviders({ config }: { config: PublicConfig }) {
  return <PlatformProvider><PreferencesProvider><ThemeProvider><ProviderGraph config={config} /></ThemeProvider></PreferencesProvider></PlatformProvider>;
}
