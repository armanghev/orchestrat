import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthContext } from "./auth-context";
import type { AuthClient, AuthSnapshot } from "./auth-client";
import { AuthCallbackScreen } from "./auth-callback-screen";

function client(snapshot: AuthSnapshot): AuthClient {
  return {
    initialize: vi.fn(async () => undefined), getSnapshot: () => snapshot,
    subscribe: () => () => undefined, signIn: vi.fn(async () => undefined),
    completeSignIn: vi.fn(async () => undefined), signOut: vi.fn(async () => undefined),
    expireSession: vi.fn(async () => undefined), getAccessToken: vi.fn(async () => null)
  };
}

describe("AuthCallbackScreen", () => {
  it("announces callback progress without rendering callback parameters", async () => {
    window.history.replaceState({}, "", "/auth/callback?code=secret-token&state=opaque");
    const auth = client({ status: "signingIn" });
    const { container } = render(<AuthContext.Provider value={auth}><AuthCallbackScreen /></AuthContext.Provider>);
    expect(screen.getByRole("status")).toHaveTextContent("Completing sign-in");
    await waitFor(() => expect(auth.completeSignIn).toHaveBeenCalledOnce());
    expect(container).not.toHaveTextContent("secret-token");
    expect(container).not.toHaveTextContent("state=opaque");
  });

  it("shows a retry link only for a stable auth error", () => {
    render(<AuthContext.Provider value={client({ status: "error", code: "state_mismatch", message: "The callback state does not match." })}><AuthCallbackScreen /></AuthContext.Provider>);
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/");
  });
});
