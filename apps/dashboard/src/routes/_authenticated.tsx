import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ context }) => {
    await context.auth.initialize();
    if (context.auth.getSnapshot().status !== "signedIn") {
      throw redirect({ to: "/" });
    }
  },
  component: () => <Outlet />
});
