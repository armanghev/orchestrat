import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthClient, AuthSnapshot } from "@/features/auth/auth-client";
import { PROJECT_INVITATION_TOKEN_KEY } from "@/features/settings/project-invitation-token";
import { renderDashboardRoute } from "@/test/render";

const apiUrl = "http://localhost:8801/api/v1";
const token = "a".repeat(43);
const nextToken = "b".repeat(43);
const project = {
  id: "00000000-0000-4000-8000-000000000099",
  organization_id: "00000000-0000-4000-8000-000000000098",
  name: "Joined project",
  slug: "joined-project",
  description: null,
  status: "active",
  role: "member",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  archived_at: null
};

class Auth implements AuthClient {
  readonly capabilities = { github: true, magicLink: true };
  private listeners = new Set<() => void>();

  constructor(private snapshot: AuthSnapshot) {}

  initialize = async () => undefined;
  completeSignIn = async () => ({
    status: "success" as const,
    identityKey: "user"
  });
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  signInWithGitHub = async () => undefined;
  sendMagicLink = async () => undefined;
  signOut = async () => undefined;
  expireSession = async () => undefined;
  getAccessToken = async () =>
    this.snapshot.status === "signedIn" ? "test-token" : null;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  window.sessionStorage.clear();
});

describe("project invitation join route", () => {
  it("accepts a signed-in invitation and opens the joined project", async () => {
    let receivedToken: string | null = null;
    const rendered = await renderDashboardRoute({
      path: `/project-invitations/join#token=${token}`,
      auth: new Auth({ status: "signedIn", identityKey: "user" }),
      platform: platform(),
      handlers: [
        http.post(
          `${apiUrl}/project-invitations/accept`,
          async ({ request }) => {
            const body = (await request.json()) as { token: string };
            receivedToken = body.token;
            return HttpResponse.json({ project });
          }
        )
      ]
    });

    await waitFor(() =>
      expect(rendered.router.state.location.pathname).toBe(
        `/projects/${project.id}/overview`
      )
    );
    expect(receivedToken).toBe(token);
    expect(
      window.sessionStorage.getItem(PROJECT_INVITATION_TOKEN_KEY)
    ).toBeNull();
  });

  it("stores the fragment token while signed out, then resumes it from the auth callback", async () => {
    await renderDashboardRoute({
      path: `/project-invitations/join#token=${token}`,
      auth: new Auth({ status: "signedOut" }),
      platform: platform()
    });
    expect(
      await screen.findByRole("button", { name: "Continue with GitHub" })
    ).toBeVisible();
    expect(window.sessionStorage.getItem(PROJECT_INVITATION_TOKEN_KEY)).toBe(
      token
    );

    const callback = await renderDashboardRoute({
      path: "/auth/callback?code=one-time",
      auth: new Auth({ status: "signedIn", identityKey: "user" }),
      platform: platform()
    });
    await waitFor(() =>
      expect(callback.router.state.location.pathname).toBe(
        "/project-invitations/join"
      )
    );
    expect(callback.router.state.location.hash).toBe(`token=${token}`);
  });

  it("ignores an invitation response after the join page unmounts", async () => {
    const response = deferred<HttpResponse<{ project: typeof project }>>();
    let requests = 0;
    const rendered = await renderDashboardRoute({
      path: `/project-invitations/join#token=${token}`,
      auth: new Auth({ status: "signedIn", identityKey: "user" }),
      platform: platform(),
      handlers: [
        http.post(`${apiUrl}/project-invitations/accept`, () => {
          requests += 1;
          return response.promise;
        })
      ]
    });
    await waitFor(() => expect(requests).toBe(1));

    rendered.unmount();
    response.resolve(HttpResponse.json({ project }));
    await Promise.resolve();

    expect(rendered.router.state.location.pathname).toBe(
      "/project-invitations/join"
    );
  });

  it("cancels an older invitation request when a different fragment opens", async () => {
    const firstResponse = deferred<HttpResponse<{ project: typeof project }>>();
    const nextProject = {
      ...project,
      id: "00000000-0000-4000-8000-000000000100",
      name: "Second project",
      slug: "second-project"
    };
    let requests = 0;
    const rendered = await renderDashboardRoute({
      path: `/project-invitations/join#token=${token}`,
      auth: new Auth({ status: "signedIn", identityKey: "user" }),
      platform: platform(),
      handlers: [
        http.post(`${apiUrl}/project-invitations/accept`, () => {
          requests += 1;
          return requests === 1
            ? firstResponse.promise
            : HttpResponse.json({ project: nextProject });
        })
      ]
    });
    await waitFor(() => expect(requests).toBe(1));

    await rendered.router.navigate({
      to: "/project-invitations/join",
      hash: `token=${nextToken}`
    });
    await waitFor(() =>
      expect(rendered.router.state.location.pathname).toBe(
        `/projects/${nextProject.id}/overview`
      )
    );

    firstResponse.resolve(HttpResponse.json({ project }));
    await Promise.resolve();
    expect(rendered.router.state.location.pathname).toBe(
      `/projects/${nextProject.id}/overview`
    );
  });
});
