import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AuthClient, AuthSnapshot } from "@/features/auth/auth-client";
import { project } from "@/test/factories";
import { renderDashboardRoute } from "@/test/render";

class FakeAuthClient implements AuthClient {
  readonly capabilities = { github: true, magicLink: true };
  constructor(private readonly snapshot: AuthSnapshot) {}
  async initialize() {}
  async completeSignIn() {
    return { status: "error" as const };
  }
  getSnapshot() {
    return this.snapshot;
  }
  subscribe() {
    return () => undefined;
  }
  async signInWithGitHub() {}
  async sendMagicLink() {}
  async signOut() {}
  async expireSession() {}
  async getAccessToken() {
    return this.snapshot.status === "signedIn" ? "test-token" : null;
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

describe("dashboard routes", () => {
  it("shows browser sign-in at the signed-out root", async () => {
    await renderDashboardRoute({
      path: "/",
      auth: new FakeAuthClient({ status: "signedOut" }),
      platform: platform()
    });
    expect(
      await screen.findByRole("button", { name: "Continue with GitHub" })
    ).toBeVisible();
  });

  it("redirects an authenticated setup flow to its first project", async () => {
    const expected = project();
    const view = await renderDashboardRoute({
      path: "/setup",
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform()
    });
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/projects/${expected.id}/overview`
      )
    );
  });

  it("renders project overview metadata", async () => {
    const expected = project();
    await renderDashboardRoute({
      path: `/projects/${expected.id}/overview`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform()
    });
    expect(
      await screen.findByRole("heading", { name: "Overview" })
    ).toBeVisible();
    expect(screen.getByText(expected.slug)).toBeVisible();
  });
});
