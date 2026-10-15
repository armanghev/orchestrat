import { useCallback, useEffect, useState } from "react";
import type { AuthInstance } from "./auth-client";
import { useAuthClient } from "./auth-context";

export type AuthInstanceState =
  | { status: "loading" }
  | { status: "ready"; instance: AuthInstance }
  | { status: "error" };

/** The server's setup and signup state, refetched when `reload` is called. */
export function useAuthInstance(): AuthInstanceState & { reload(): void } {
  const client = useAuthClient();
  const [state, setState] = useState<AuthInstanceState>({ status: "loading" });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    client.getInstance({ refresh: version > 0 }).then(
      (instance) => {
        if (active) setState({ status: "ready", instance });
      },
      () => {
        if (active) setState({ status: "error" });
      }
    );
    return () => {
      active = false;
    };
  }, [client, version]);

  const reload = useCallback(() => {
    setState((current) =>
      current.status === "error" ? { status: "loading" } : current
    );
    setVersion((current) => current + 1);
  }, []);
  return { ...state, reload };
}
