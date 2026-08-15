import { useCallback, useEffect, useRef } from "react";
import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useAuthClient } from "@/features/auth/auth-context";
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
  const location = useLocation();
  const navigate = useNavigate();
  const callbackUrl = useRef(browserCallbackUrl(location.pathname, location.searchStr)).current;
  const handleSuccess = useCallback(() => { void navigate({ to: "/setup", replace: true }); }, [navigate]);

  useEffect(() => {
    if (location.searchStr) void navigate({ to: "/auth/callback", search: {}, replace: true });
  }, [location.searchStr, navigate]);

  return <AuthCallbackScreen
    callbackUrl={callbackUrl}
    onSuccess={handleSuccess}
    onRetry={() => {
      void auth.expireSession().catch(() => undefined).then(() => navigate({ to: "/", replace: true }));
    }}
  />;
}

export const Route = createFileRoute("/auth/callback")({
  validateSearch: callbackSearchSchema,
  component: AuthCallbackRoute
});
