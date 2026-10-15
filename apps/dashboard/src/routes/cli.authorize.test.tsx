import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { AuthSnapshot } from "@/features/auth/auth-client";
import { FakeAuthClient } from "@/test/fake-auth-client";
import { renderDashboardRoute } from "@/test/render";
import { CLI_ATTEMPT_KEY, CLI_TERMINAL_KEY } from "./cli.authorize";

const apiUrl = "http://localhost:8801/api/v1";
const attempt = "ca_12345678901234567890";

class Auth extends FakeAuthClient {
  constructor(snapshot: AuthSnapshot, result: AuthSnapshot = snapshot) {
    super(snapshot);
    this.getAccessToken.mockImplementation(async () =>
      result.status === "signedIn" ? "test-token" : null
    );
  }
}

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

describe("CLI authorization route", () => {
  it("rejects invalid and extra search values without exposing a secret", async () => {
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      CLI_TERMINAL_KEY,
      JSON.stringify({ status: "approved" })
    );
    await renderDashboardRoute({
      path: "/cli/authorize?attempt=bad",
      auth: new Auth({ status: "signedOut" }),
      platform: platform()
    });
    expect(
      await screen.findByRole("heading", { name: "Invalid authorization link" })
    ).toBeVisible();
    expect(window.sessionStorage.getItem(CLI_TERMINAL_KEY)).toContain(
      '"status":"approved"'
    );
    expect(screen.queryByText("super-secret")).not.toBeInTheDocument();
  });

  it("stores only the attempt for signed-out retry", async () => {
    await renderDashboardRoute({
      path: `/cli/authorize?attempt=${attempt}`,
      auth: new Auth({ status: "signedOut" }),
      platform: platform()
    });
    expect(
      await screen.findByRole("button", { name: "Sign in" })
    ).toBeVisible();
    expect(
      window.sessionStorage.getItem("orchestrat.cli.authorization.attempt")
    ).toBe(attempt);
    expect(
      window.sessionStorage.getItem("orchestrat.cli.authorization.secret")
    ).toBeNull();
  });

  it("approves the exact attempt, then keeps terminal confirmation", async () => {
    let body: unknown;
    await renderDashboardRoute({
      path: `/cli/authorize?attempt=${attempt}`,
      auth: new Auth({ status: "signedIn", identityKey: "user" }),
      platform: platform(),
      handlers: [
        http.post(
          `${apiUrl}/cli/authorization/attempts/${attempt}/approve`,
          async ({ request }) => {
            body = await request.json();
            return HttpResponse.json({ status: "approved" });
          }
        )
      ]
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Approve" }));
    expect(
      await screen.findByRole("heading", { name: "CLI access approved." })
    ).toBeVisible();
    expect(body).toEqual({});
    expect(window.location.search).toBe("");
    expect(
      JSON.parse(window.sessionStorage.getItem(CLI_TERMINAL_KEY)!)
    ).toEqual({
      status: "approved"
    });
    expect(window.sessionStorage.getItem(CLI_ATTEMPT_KEY)).toBeNull();
    expect(document.body.textContent).not.toContain("super-secret");
  });

  it("restores a generic terminal confirmation after reload without an attempt", async () => {
    window.sessionStorage.clear();
    window.sessionStorage.setItem(
      CLI_TERMINAL_KEY,
      JSON.stringify({ status: "approved" })
    );
    await renderDashboardRoute({
      path: "/cli/authorize",
      auth: new Auth({ status: "signedIn", identityKey: "user" }),
      platform: platform()
    });
    expect(
      await screen.findByRole("heading", { name: "CLI access approved." })
    ).toBeVisible();
  });

  it("keeps deny available and reports terminal confirmation", async () => {
    let denied = false;
    await renderDashboardRoute({
      path: `/cli/authorize?attempt=${attempt}`,
      auth: new Auth({ status: "signedIn", identityKey: "user" }),
      platform: platform(),
      handlers: [
        http.post(
          `${apiUrl}/cli/authorization/attempts/${attempt}/deny`,
          () => {
            denied = true;
            return HttpResponse.json({ status: "denied" });
          }
        )
      ]
    });
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Deny" }));
    expect(denied).toBe(true);
    expect(
      await screen.findByRole("heading", { name: "CLI access denied." })
    ).toBeVisible();
    expect(window.location.search).toBe("");
    await waitFor(() =>
      expect(window.sessionStorage.getItem(CLI_TERMINAL_KEY)).toContain(
        '"status":"denied"'
      )
    );
  });

  it("shows a generic decision error without transport details", async () => {
    await renderDashboardRoute({
      path: `/cli/authorize?attempt=${attempt}`,
      auth: new Auth({ status: "signedIn", identityKey: "user" }),
      platform: platform(),
      handlers: [
        http.post(
          `${apiUrl}/cli/authorization/attempts/${attempt}/approve`,
          () =>
            HttpResponse.json(
              { error: { message: "secret=leaked" } },
              { status: 500 }
            )
        )
      ]
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to update CLI authorization. Try again."
    );
    expect(screen.queryByText("secret=leaked")).not.toBeInTheDocument();
  });

  it("returns a consumed pending attempt after sign-in and keeps ordinary onboarding", async () => {
    window.sessionStorage.setItem(
      "orchestrat.cli.authorization.attempt",
      attempt
    );
    const returned = await renderDashboardRoute({
      path: "/",
      auth: new Auth({ status: "signedIn", identityKey: "user" }),
      platform: platform()
    });
    await waitFor(() =>
      expect(returned.router.state.location.pathname).toBe("/cli/authorize")
    );
    expect(returned.router.state.location.search).toEqual({ attempt });
    expect(
      window.sessionStorage.getItem("orchestrat.cli.authorization.attempt")
    ).toBeNull();

    const ordinary = await renderDashboardRoute({
      path: "/",
      auth: new Auth({ status: "signedIn", identityKey: "user" }),
      platform: platform()
    });
    await waitFor(() =>
      expect(ordinary.router.state.location.pathname).toBe("/onboarding")
    );
  });
});
