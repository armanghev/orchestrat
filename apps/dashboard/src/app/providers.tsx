import { useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { PublicConfig } from "@/app/config";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/features/auth/auth-provider";
import { loadingAuthClient } from "@/features/auth/auth-client";
import { useAuthClient } from "@/features/auth/auth-context";
import { ApiClient } from "@/lib/api/client";
import { PlatformProvider, usePlatform } from "@/platform/provider";
import { createDashboardQueryClient } from "./query-client";
import { createAppRouter } from "./router";

function RouterRuntime({ config }: { config: PublicConfig }) {
  const auth = useAuthClient();
  const platform = usePlatform();
  const [queryClient] = useState(createDashboardQueryClient);
  const [api] = useState(() => new ApiClient(config.apiUrl, auth));
  const [router] = useState(() => createAppRouter({ api, auth, platform, queryClient }));

  useEffect(() => {
    let previousStatus = auth.getSnapshot().status;
    return auth.subscribe(() => {
      const status = auth.getSnapshot().status;
      if (previousStatus === "signedIn" && status === "signedOut") {
        queryClient.clear();
        void router.navigate({ to: "/" });
      }
      previousStatus = status;
    });
  }, [auth, queryClient, router]);

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
  return <PlatformProvider><ProviderGraph config={config} /></PlatformProvider>;
}
