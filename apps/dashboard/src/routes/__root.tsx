import {
  createRootRouteWithContext,
  Link,
  Outlet
} from "@tanstack/react-router";
import { ApplicationError } from "@/app/application-error";
import type { AppRouterContext } from "@/app/router-context";

function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        The page you requested is unavailable.
      </p>
      <Link className="mt-6 text-sm text-primary underline" to="/">
        Return to dashboard
      </Link>
    </main>
  );
}

export const Route = createRootRouteWithContext<AppRouterContext>()({
  component: () => <Outlet />,
  notFoundComponent: NotFound,
  errorComponent: ApplicationError
});
