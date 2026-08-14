import { act, render } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import type { RequestHandler } from "msw";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createDashboardQueryClient } from "@/app/query-client";
import { createAppRouter } from "@/app/router";
import type { AuthClient } from "@/features/auth/auth-client";
import { AuthContext } from "@/features/auth/auth-context";
import { ApiClient } from "@/lib/api/client";
import type { Platform } from "@/platform/contract";
import { PlatformProvider } from "@/platform/provider";
import { handlers as defaultHandlers } from "@/test/handlers";
import { server } from "@/test/msw-server";

export async function renderDashboardRoute({
  path,
  auth,
  platform,
  handlers = defaultHandlers
}: {
  path: string;
  auth: AuthClient;
  platform: Platform;
  handlers?: RequestHandler[];
}) {
  server.use(...handlers);
  const queryClient = createDashboardQueryClient();
  const api = new ApiClient("http://localhost:3001", auth);
  const history = createMemoryHistory({ initialEntries: [path] });
  const context = { api, auth, platform, queryClient };
  const router = createAppRouter(context, history);

  const view = render(
    <PlatformProvider value={platform}>
      <AuthContext.Provider value={auth}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <RouterProvider router={router} context={context} />
          </TooltipProvider>
        </QueryClientProvider>
      </AuthContext.Provider>
    </PlatformProvider>
  );
  await act(async () => { await router.load(); });
  return { ...view, router, queryClient, auth, platform };
}
