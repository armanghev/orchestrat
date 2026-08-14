import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useAuthSnapshot } from "@/features/auth/auth-context";
import { SignInScreen } from "@/features/auth/sign-in-screen";

function IndexRoute() {
  const snapshot = useAuthSnapshot();
  if (snapshot.status === "loading") {
    return <main className="flex min-h-screen items-center justify-center"><p role="status" aria-label="Restoring session…">Restoring session…</p></main>;
  }
  if (snapshot.status === "signedIn") return <Navigate to="/setup" replace />;
  return <SignInScreen />;
}

export const Route = createFileRoute("/")({ component: IndexRoute });
