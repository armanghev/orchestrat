import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { AuthClient, AuthSnapshot } from "@/features/auth/auth-client";
import { organization } from "@/test/factories";
import { renderDashboardRoute } from "@/test/render";

const apiUrl = "http://localhost:3001/api/v1";

class FakeAuthClient implements AuthClient {
  readonly capabilities = { github: true, magicLink: true };
  private readonly snapshot: AuthSnapshot = {
    status: "signedIn",
    identityKey: "setup-user"
  };
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
    return "test-token";
  }
}

const platform = {
  kind: "web" as const,
  preferences: {
    load: vi.fn(async () => null),
    save: vi.fn(async () => undefined)
  },
  openExternal: vi.fn(async () => undefined),
  onAuthCallback: vi.fn(async () => () => undefined)
};

describe("SetupFlow", () => {
  it("shows organization creation when no organization is available", async () => {
    await renderDashboardRoute({
      path: "/setup",
      auth: new FakeAuthClient(),
      platform,
      handlers: [
        http.get(`${apiUrl}/organizations`, () =>
          HttpResponse.json({ organizations: [] })
        )
      ]
    });
    expect(
      await screen.findByRole("heading", { name: "Create your organization" })
    ).toBeVisible();
  });

  it("moves from organization creation directly to project creation", async () => {
    const created = organization({ name: "Acme" });
    await renderDashboardRoute({
      path: "/setup",
      auth: new FakeAuthClient(),
      platform,
      handlers: [
        http.get(`${apiUrl}/organizations`, () =>
          HttpResponse.json({ organizations: [] })
        ),
        http.post(`${apiUrl}/organizations`, () =>
          HttpResponse.json(created, { status: 201 })
        ),
        http.get(`${apiUrl}/organizations/${created.id}/projects`, () =>
          HttpResponse.json({ projects: [] })
        )
      ]
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Organization name"), "Acme");
    await user.click(
      screen.getByRole("button", { name: "Create organization" })
    );
    expect(
      await screen.findByRole("heading", { name: "Create your project" })
    ).toBeVisible();
  });
});
