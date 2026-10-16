import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAuthClient } from "@/test/fake-auth-client";
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

class Auth extends FakeAuthClient {}

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

  it("keeps the fragment token while signed out and resumes it after sign-in", async () => {
    await renderDashboardRoute({
      path: `/project-invitations/join#token=${token}`,
      auth: new Auth({ status: "signedOut" }),
      platform: platform()
    });
    expect(
      await screen.findByText(
        "Sign in or create an account to join the project."
      )
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Create an account" })
    ).toHaveAttribute("href", `/signup?invite=${token}`);
    expect(window.sessionStorage.getItem(PROJECT_INVITATION_TOKEN_KEY)).toBe(
      token
    );

    const signedIn = await renderDashboardRoute({
      path: "/",
      auth: new Auth({ status: "signedIn", identityKey: "user" }),
      platform: platform()
    });
    await waitFor(() =>
      expect(signedIn.router.state.location.pathname).toBe(
        "/project-invitations/join"
      )
    );
    expect(signedIn.router.state.location.hash).toBe(`token=${token}`);
  });

  it("accepts the invitation in place after signing in on the join page", async () => {
    let accepted = 0;
    const auth = new Auth({ status: "signedOut" });
    auth.signIn.mockImplementation(async () =>
      auth.emit({ status: "signedIn", identityKey: "user" })
    );
    const rendered = await renderDashboardRoute({
      path: `/project-invitations/join#token=${token}`,
      auth,
      platform: platform(),
      handlers: [
        http.post(`${apiUrl}/project-invitations/accept`, () => {
          accepted += 1;
          return HttpResponse.json({ project });
        })
      ]
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(rendered.router.state.location.pathname).toBe(
        `/projects/${project.id}/overview`
      )
    );
    expect(auth.signIn).toHaveBeenCalledWith(
      "ada@example.com",
      "correct horse battery"
    );
    expect(accepted).toBe(1);
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
