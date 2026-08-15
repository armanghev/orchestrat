import { useCallback, useState } from "react";
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
  const [callbackHandedOff, setCallbackHandedOff] = useState(false);
  const callbackUrl = callbackHandedOff ? null : browserCallbackUrl(location.pathname, location.searchStr);
  const handleHandoff = useCallback(() => {
    setCallbackHandedOff(true);
    void navigate({ to: "/auth/callback", search: {}, replace: true });
  }, [navigate]);
  const handleSuccess = useCallback(() => { void navigate({ to: "/setup", replace: true }); }, [navigate]);

  return <AuthCallbackScreen
    callbackUrl={callbackUrl}
    onHandoff={handleHandoff}
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
