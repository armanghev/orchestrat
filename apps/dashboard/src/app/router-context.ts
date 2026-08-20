import type { QueryClient } from "@tanstack/react-query";
import type { AuthClient } from "@/features/auth/auth-client";
import type { ApiClient } from "@/lib/api/client";
import type { Platform } from "@/platform/contract";

export type AppRouterContext = {
  api: ApiClient;
  auth: AuthClient;
  platform: Platform;
  queryClient: QueryClient;
};
