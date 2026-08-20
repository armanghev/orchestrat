import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { routeTree } from "@/routeTree.gen";
import type { AppRouterContext } from "./router-context";

export function createAppRouter(
  context: AppRouterContext,
  history?: RouterHistory
) {
  return createRouter({
    routeTree,
    context,
    history,
    defaultPreload: "intent"
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
