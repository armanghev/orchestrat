import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AuthContext } from "./auth-context";
import type { AuthCapabilities, AuthClient, AuthSnapshot } from "./auth-client";
import { SignInScreen } from "./sign-in-screen";

function client(
  snapshot: AuthSnapshot,
  capabilities: AuthCapabilities = { github: true, magicLink: true }
): AuthClient {
  return {
    capabilities,
    initialize: vi.fn(async () => undefined),
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    signInWithGitHub: vi.fn(async () => undefined),
    sendMagicLink: vi.fn(async () => undefined),
    completeSignIn: vi.fn(async () => ({ status: "error" as const })),
    signOut: vi.fn(async () => undefined),
    expireSession: vi.fn(async () => undefined),
    getAccessToken: vi.fn(async () => null)
  };
}

function renderScreen(auth: AuthClient) {
  return render(
    <AuthContext.Provider value={auth}>
      <SignInScreen />
    </AuthContext.Provider>
  );
}

describe("SignInScreen", () => {
  it("offers accessible GitHub and magic-link actions for web auth", async () => {
    const auth = client({ status: "signedOut" });
    renderScreen(auth);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Continue with GitHub" }));
    expect(auth.signInWithGitHub).toHaveBeenCalledOnce();
    expect(screen.getByRole("separator", { name: "or" })).toBeVisible();

    await userEvent
      .setup()
      .type(screen.getByLabelText("Email address"), " Person@Example.com ");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    expect(auth.sendMagicLink).toHaveBeenCalledWith("Person@Example.com");
    expect(
      screen.getByRole("heading", { name: "Coordinate agents. Keep control." })
    ).toBeVisible();
  });

  it("hides magic-link controls when the selected adapter does not support them", () => {
    renderScreen(
      client({ status: "signedOut" }, { github: true, magicLink: false })
    );
    expect(
      screen.getByRole("button", { name: "Continue with GitHub" })
    ).toBeVisible();
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("disables duplicate actions while each request is pending", () => {
    const github = renderScreen(client({ status: "signingIn" }));
    expect(
      screen.getByRole("button", { name: "Connecting to GitHub…" })
    ).toBeDisabled();
    github.unmount();

    renderScreen(
      client({ status: "sendingMagicLink", email: "person@example.com" })
    );
    expect(screen.getByLabelText("Email address")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Sending sign-in link…" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Continue with GitHub" })
    ).toBeDisabled();
  });

  it("shows the confirmation when an in-place request transitions to accepted", () => {
    const first = client({ status: "signedOut" });
    const view = renderScreen(first);
    const accepted = client({
      status: "magicLinkSent",
      email: "person@example.com"
    });
    view.rerender(
      <AuthContext.Provider value={accepted}>
        <SignInScreen />
      </AuthContext.Provider>
    );
    expect(screen.getByRole("status")).toHaveTextContent("Check your email");
  });

  it("honestly confirms request acceptance and supports retry or changing email", async () => {
    const auth = client({
      status: "magicLinkSent",
      email: "person@example.com"
    });
    renderScreen(auth);
    expect(screen.getByRole("status")).toHaveTextContent("Check your email");
    expect(screen.getByText(/•••@example\.com/)).toBeVisible();
    expect(screen.queryByText(/person@example\.com/)).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Send again" }));
    expect(auth.sendMagicLink).toHaveBeenCalledWith("person@example.com");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Use a different email" }));
    expect(screen.getByLabelText("Email address")).toHaveFocus();
  });

  it("never renders adapter error details", () => {
    renderScreen(
      client({
        status: "error",
        code: "provider_error",
        message: "private provider details"
      })
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "We couldn't sign you in. Try again."
    );
    expect(
      screen.queryByText("private provider details")
    ).not.toBeInTheDocument();
  });
});
