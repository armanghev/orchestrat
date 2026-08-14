import { Button } from "@/components/ui/button";
import { useAuthClient, useAuthSnapshot } from "./auth-context";

export function SignInScreen() {
  const client = useAuthClient();
  const snapshot = useAuthSnapshot();
  const signIn = () => { void client.signIn(); };

  return <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 text-center">
    <p className="mb-5 text-sm font-semibold tracking-[0.2em] text-primary">ORCHESTRAT</p>
    <h1 className="text-3xl font-semibold tracking-tight">Coordinate agents. Keep control.</h1>
    <p className="mt-4 text-sm text-muted-foreground">Sign in in your browser to continue to the dashboard.</p>
    <div className="mt-8">
      {snapshot.status === "signingIn" ? <Button className="w-full" disabled>Waiting for browser…</Button> :
        snapshot.status === "error" ? <>
          <p role="alert" className="mb-4 text-sm text-destructive">{snapshot.message}</p>
          <Button className="w-full" onClick={signIn}>Try again</Button>
        </> :
        <Button className="w-full" onClick={signIn} disabled={snapshot.status === "loading"}>Continue in browser</Button>}
    </div>
  </main>;
}
