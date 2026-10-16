import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAuthClient, signedIn, signedOut } from "@/test/fake-auth-client";
import { renderDashboardRoute } from "@/test/render";
import { AuthRequestError } from "./auth-client";

function platform() {
  return {
    kind: "web" as const,
    preferences: {
      load: vi.fn(async () => null),
      save: vi.fn(async () => undefined)
    },
    openExternal: vi.fn(async () => undefined),
    onAuthCallback: vi.fn(async () => () => undefined)
  };
}

function renderRoot(auth: FakeAuthClient, path = "/") {
  return renderDashboardRoute({ path, auth, platform: platform() });
}

afterEach(() => window.sessionStorage.clear());

describe("sign-in screen", () => {
  it("signs in with email and password, then leaves for onboarding", async () => {
    const auth = new FakeAuthClient(signedOut);
    auth.signIn.mockImplementation(async () => auth.emit(signedIn()));
    const view = await renderRoot(auth);
    const user = userEvent.setup();

    await user.type(
      await screen.findByLabelText("Email"),
      "  Ada@Example.com "
    );
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(auth.signIn).toHaveBeenCalledWith(
      "ada@example.com",
      "correct horse battery"
    );
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe("/onboarding")
    );
  });

  it("shows a wrong password inline and keeps the form", async () => {
    const auth = new FakeAuthClient(signedOut);
    auth.signIn.mockRejectedValueOnce(
      new AuthRequestError("Nope", "INVALID_CREDENTIALS", 401)
    );
    await renderRoot(auth);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Email or password is incorrect."
    );
    expect(screen.getByLabelText("Email")).toHaveValue("ada@example.com");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("says how long to wait when sign-in is rate limited", async () => {
    const auth = new FakeAuthClient(signedOut);
    auth.signIn.mockRejectedValueOnce(
      new AuthRequestError("Too many", "RATE_LIMITED", 429, 42)
    );
    await renderRoot(auth);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "secret-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many sign-in attempts. Try again in 42 seconds."
    );
  });

  it("checks the fields before calling the server", async () => {
    const auth = new FakeAuthClient(signedOut);
    await renderRoot(auth);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "a@.com");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const email = screen.getByLabelText("Email");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAccessibleDescription("Enter a valid email address.");
    expect(email).toHaveFocus();
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
      "Enter your password."
    );
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it.each([
    ["invite", true],
    ["open", true],
    ["closed", false]
  ] as const)(
    "links to account creation in %s signup mode: %s",
    async (mode, linked) => {
      const auth = new FakeAuthClient(signedOut, {
        needs_setup: false,
        signup_mode: mode
      });
      await renderRoot(auth);
      await screen.findByRole("heading", { name: "Sign in to Orchestrat" });
      if (linked)
        expect(
          screen.getByRole("link", { name: "Create an account" })
        ).toHaveAttribute("href", "/signup");
      else {
        expect(
          screen.queryByRole("link", { name: "Create an account" })
        ).not.toBeInTheDocument();
        expect(
          screen.getByText(
            "Need an account? Ask an admin to create your account."
          )
        ).toBeVisible();
      }
    }
  );

  it("offers a retry when the server can't be reached", async () => {
    const auth = new FakeAuthClient(signedOut);
    auth.getInstance
      .mockRejectedValueOnce(new AuthRequestError("x", "NETWORK_ERROR", null))
      .mockResolvedValueOnce({ needs_setup: false, signup_mode: "open" });
    await renderRoot(auth);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't reach this Orchestrat server."
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("link", { name: "Create an account" })
    ).toBeVisible();
    expect(auth.getInstance).toHaveBeenLastCalledWith({ refresh: true });
  });
});

describe("first-run setup", () => {
  const empty = { needs_setup: true, signup_mode: "invite" } as const;

  it("creates the admin account with the setup token from the URL", async () => {
    const auth = new FakeAuthClient(signedOut, empty);
    auth.signUp.mockImplementation(async () => {
      auth.emit(signedIn());
      return { invitedProjectId: null };
    });
    const view = await renderRoot(auth, "/?setup_token=tok_from_log");
    expect(
      await screen.findByRole("heading", {
        name: "Set up this Orchestrat server"
      })
    ).toBeVisible();
    const token = screen.getByLabelText("Setup token");
    expect(token).toHaveValue("tok_from_log");
    expect(token).toHaveAccessibleDescription(
      "Printed in the server log at startup, or set with ORCHESTRAT_SETUP_TOKEN."
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.type(
      screen.getByLabelText("Confirm password"),
      "correct horse battery"
    );
    await user.click(
      screen.getByRole("button", { name: "Create admin account" })
    );

    expect(auth.signUp).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "correct horse battery",
      fullName: "Ada Lovelace",
      inviteToken: undefined,
      setupToken: "tok_from_log"
    });
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe("/onboarding")
    );
  });

  it("validates the form and shows a rejected setup token on its field", async () => {
    const auth = new FakeAuthClient(signedOut, empty);
    auth.signUp.mockRejectedValueOnce(
      new AuthRequestError("x", "SETUP_TOKEN_REQUIRED", 403)
    );
    await renderRoot(auth);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Create admin account" })
    );
    expect(screen.getByLabelText("Setup token")).toHaveFocus();
    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription(
      "Enter your name."
    );
    expect(auth.signUp).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Setup token"), "wrong-token");
    await user.type(screen.getByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.type(screen.getByLabelText("Confirm password"), "different");
    await user.click(
      screen.getByRole("button", { name: "Create admin account" })
    );
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(
      /Use at least 10 characters\./
    );
    expect(
      screen.getByLabelText("Confirm password")
    ).toHaveAccessibleDescription("The passwords don't match.");

    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.clear(screen.getByLabelText("Confirm password"));
    await user.type(
      screen.getByLabelText("Confirm password"),
      "correct horse battery"
    );
    await user.click(
      screen.getByRole("button", { name: "Create admin account" })
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Setup token")).toHaveAccessibleDescription(
        /This setup token is missing or wrong\. Copy it from the server log\./
      )
    );
    expect(screen.getByLabelText("Setup token")).toHaveFocus();
  });

  it("falls back to sign-in when someone else finished setup first", async () => {
    const auth = new FakeAuthClient(signedOut, empty);
    auth.signUp.mockImplementationOnce(async () => {
      auth.setInstance({ needs_setup: false, signup_mode: "invite" });
      throw new AuthRequestError("x", "INVITE_REQUIRED", 403);
    });
    await renderRoot(auth, "/?setup_token=late");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Name"), "Ada");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.type(
      screen.getByLabelText("Confirm password"),
      "correct horse battery"
    );
    await user.click(
      screen.getByRole("button", { name: "Create admin account" })
    );
    expect(
      await screen.findByRole("heading", { name: "Sign in to Orchestrat" })
    ).toBeVisible();
  });
});
