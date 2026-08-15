import { useEffect } from "react";
import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useAuthClient, useAuthSnapshot } from "@/features/auth/auth-context";
import { AuthCallbackScreen } from "@/features/auth/auth-callback-screen";

const callbackSearchSchema = z.looseObject({
  code: z.unknown().optional(),
  error: z.unknown().optional(),
  error_code: z.unknown().optional(),
  error_description: z.unknown().optional()
});

function browserCallbackUrl(pathname: string, search: string): string {
  return new URL(`${pathname}${search}`, window.location.origin).toString();
}

function AuthCallbackRoute() {
  const auth = useAuthClient();
  const snapshot = useAuthSnapshot();
  const location = useLocation();
  const navigate = useNavigate();
  const callbackUrl = browserCallbackUrl(location.pathname, location.searchStr);

  useEffect(() => {
    if (location.searchStr) void navigate({ to: "/auth/callback", search: {}, replace: true });
  }, [location.searchStr, navigate]);

  useEffect(() => {
    if (snapshot.status === "signedIn") void navigate({ to: "/setup", replace: true });
  }, [navigate, snapshot.status]);

  return <AuthCallbackScreen
    callbackUrl={callbackUrl}
    onRetry={() => {
      void auth.expireSession().catch(() => undefined).then(() => navigate({ to: "/", replace: true }));
    }}
  />;
}

export const Route = createFileRoute("/auth/callback")({
  validateSearch: callbackSearchSchema,
  component: AuthCallbackRoute
});
