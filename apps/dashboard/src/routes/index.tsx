import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { useAuthSnapshot } from "@/features/auth/auth-context";
import { PostAuthRedirect } from "@/features/auth/post-auth";
import { SignInScreen } from "@/features/auth/sign-in-screen";

function IndexRoute() {
  const snapshot = useAuthSnapshot();
  const { setup_token: setupToken } = Route.useSearch();
  if (snapshot.status === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p role="status" aria-label="Restoring session…">
          Restoring session…
        </p>
      </main>
    );
  }
  if (snapshot.status === "signedIn") return <PostAuthRedirect />;
  return <SignInScreen setupToken={setupToken} />;
}

export const Route = createFileRoute("/")({
  // The server logs `/?setup_token=…` for first-run setup.
  validateSearch: z.object({
    setup_token: z.string().max(512).optional().catch(undefined)
  }),
  component: IndexRoute
});
