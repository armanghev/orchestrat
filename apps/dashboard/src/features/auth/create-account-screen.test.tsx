import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_INVITATION_TOKEN_KEY } from "@/features/settings/project-invitation-token";
import { FakeAuthClient, signedIn, signedOut } from "@/test/fake-auth-client";
import { renderDashboardRoute } from "@/test/render";
import { AuthRequestError, type AuthInstance } from "./auth-client";

const token = "a".repeat(43);
const projectId = "00000000-0000-4000-8000-000000000099";

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

function renderSignup(
  path: string,
  instance: AuthInstance = { needs_setup: false, signup_mode: "invite" },
  auth = new FakeAuthClient(signedOut, instance)
) {
  return renderDashboardRoute({ path, auth, platform: platform() });
}

async function fillAccount(password = "correct horse battery") {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Name"), "Grace Hopper");
  await user.type(screen.getByLabelText("Email"), "grace@example.com");
  await user.type(screen.getByLabelText("Password"), password);
  await user.type(screen.getByLabelText("Confirm password"), password);
  return user;
}

afterEach(() => window.sessionStorage.clear());

describe("create account", () => {
  it("asks for an invite link on an invite-only server", async () => {
    await renderSignup("/signup");
    expect(
      await screen.findByText(
        "This server is invite-only. Ask a teammate for an invite link."
      )
    ).toBeVisible();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/"
    );
  });

  it("sends people to an admin when signup is closed, even with an invite", async () => {
    await renderSignup(`/signup?invite=${token}`, {
      needs_setup: false,
      signup_mode: "closed"
    });
    expect(
      await screen.findByText(
        "This server doesn't allow new accounts. Ask an admin to create your account."
      )
    ).toBeVisible();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("signs up with an invite and opens the joined project without accepting again", async () => {
    let accepts = 0;
    const auth = new FakeAuthClient(signedOut);
    auth.signUp.mockImplementation(async () => {
      auth.emit(signedIn());
      return { invitedProjectId: projectId };
    });
    const view = await renderDashboardRoute({
      path: `/signup?invite=${token}`,
      auth,
      platform: platform(),
      handlers: [
        http.post(
          "http://localhost:8801/api/v1/project-invitations/accept",
          () => {
            accepts += 1;
            return HttpResponse.json({});
          }
        )
      ]
    });
    expect(
      await screen.findByText("You'll join the project you were invited to.")
    ).toBeVisible();
    expect(window.sessionStorage.getItem(PROJECT_INVITATION_TOKEN_KEY)).toBe(
      token
    );
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      `/project-invitations/join#token=${token}`
    );

    const user = await fillAccount();
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(auth.signUp).toHaveBeenCalledWith({
      email: "grace@example.com",
      password: "correct horse battery",
      fullName: "Grace Hopper",
      inviteToken: token,
      setupToken: undefined
    });
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/projects/${projectId}/overview`
      )
    );
    expect(accepts).toBe(0);
    expect(
      window.sessionStorage.getItem(PROJECT_INVITATION_TOKEN_KEY)
    ).toBeNull();
  });

  it("signs up without an invite on an open server and lands in onboarding", async () => {
    const auth = new FakeAuthClient(signedOut, {
      needs_setup: false,
      signup_mode: "open"
    });
    auth.signUp.mockImplementation(async () => {
      auth.emit(signedIn());
      return { invitedProjectId: null };
    });
    const view = await renderSignup("/signup", undefined, auth);
    expect(
      await screen.findByText("Create an account on this Orchestrat server.")
    ).toBeVisible();
    const user = await fillAccount();
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe("/onboarding")
    );
  });

  it("shows a taken email on its field and an expired invite as an alert", async () => {
    const auth = new FakeAuthClient(signedOut);
    auth.signUp
      .mockRejectedValueOnce(new AuthRequestError("x", "EMAIL_TAKEN", 409))
      .mockRejectedValueOnce(new AuthRequestError("x", "INVITE_REQUIRED", 403));
    await renderSignup(`/signup?invite=${token}`, undefined, auth);
    const user = await fillAccount();

    await user.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Email")).toHaveAccessibleDescription(
        "An account with this email already exists. Sign in instead."
      )
    );
    expect(screen.getByLabelText("Email")).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This invite link is invalid or has expired. Ask a teammate for a new one."
    );
  });

  it("shows first-run setup on an empty server", async () => {
    await renderSignup("/signup?setup_token=tok_123", {
      needs_setup: true,
      signup_mode: "closed"
    });
    expect(
      await screen.findByRole("heading", {
        name: "Set up this Orchestrat server"
      })
    ).toBeVisible();
    expect(screen.getByLabelText("Setup token")).toHaveValue("tok_123");
  });

  it("sends a signed-in visitor on", async () => {
    const view = await renderSignup(
      "/signup",
      undefined,
      new FakeAuthClient(signedIn())
    );
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe("/onboarding")
    );
  });
});
