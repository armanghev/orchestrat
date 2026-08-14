import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AuthContext } from "./auth-context";
import type { AuthClient, AuthSnapshot } from "./auth-client";
import { SignInScreen } from "./sign-in-screen";

function client(snapshot: AuthSnapshot): AuthClient {
  return {
    initialize: vi.fn(async () => undefined), getSnapshot: () => snapshot,
    subscribe: () => () => undefined, signIn: vi.fn(async () => undefined),
    completeSignIn: vi.fn(async () => undefined), signOut: vi.fn(async () => undefined),
    expireSession: vi.fn(async () => undefined), getAccessToken: vi.fn(async () => null)
  };
}

describe("SignInScreen", () => {
  it("offers a browser sign-in action while signed out", async () => {
    const auth = client({ status: "signedOut" });
    render(<AuthContext.Provider value={auth}><SignInScreen /></AuthContext.Provider>);
    await userEvent.setup().click(screen.getByRole("button", { name: "Continue in browser" }));
    expect(auth.signIn).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Coordinate agents. Keep control." })).toBeVisible();
    expect(screen.getByText("ORCHESTRAT")).toHaveClass("text-primary-text");
  });

  it("shows a disabled waiting action while signing in", () => {
    render(<AuthContext.Provider value={client({ status: "signingIn" })}><SignInScreen /></AuthContext.Provider>);
    expect(screen.getByRole("button", { name: "Waiting for browser…" })).toBeDisabled();
  });

  it("labels auth errors and provides a retry action", async () => {
    const auth = client({ status: "error", code: "state_mismatch", message: "The callback state does not match." });
    render(<AuthContext.Provider value={auth}><SignInScreen /></AuthContext.Provider>);
    expect(screen.getByRole("alert")).toHaveTextContent("The callback state does not match.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(auth.signIn).toHaveBeenCalledOnce();
  });
});
