import { QueryClient } from "@tanstack/react-query";

export function createDashboardQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: (count, error) =>
          count < 2 &&
          !(error instanceof Error && error.name === "DashboardApiError")
      },
      mutations: { retry: false }
    }
  });
}
