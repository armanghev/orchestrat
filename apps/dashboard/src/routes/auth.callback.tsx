import { useEffect } from "react";
import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useAuthClient, useAuthSnapshot } from "@/features/auth/auth-context";
import { AuthCallbackScreen } from "@/features/auth/auth-callback-screen";

const callbackSearchSchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional()
});

function browserCallbackUrl(pathname: string, search: string): string {
  // Rebuild from the router location so a route can never forward a foreign URL.
  return new URL(`${pathname}${search}`, window.location.origin).toString();
}

function AuthCallbackRoute() {
  const auth = useAuthClient();
  const snapshot = useAuthSnapshot();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (snapshot.status === "signedIn") {
      void navigate({ to: "/setup", replace: true });
    }
  }, [navigate, snapshot.status]);

  return <AuthCallbackScreen
    callbackUrl={browserCallbackUrl(location.pathname, location.searchStr)}
    onRetry={() => {
      void auth.expireSession().catch(() => undefined).then(() => navigate({ to: "/", replace: true }));
    }}
  />;
}

export const Route = createFileRoute("/auth/callback")({
  validateSearch: callbackSearchSchema,
  component: AuthCallbackRoute
});
