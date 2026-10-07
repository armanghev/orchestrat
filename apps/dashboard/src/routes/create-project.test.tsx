import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, type RequestHandler } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { organization, project } from "@/test/factories";
import { handlers } from "@/test/handlers";
import { renderDashboardRoute } from "@/test/render";
import { Auth, platform } from "@/test/branch-routes";
import { REPOSITORY_ATTEMPT_KEY } from "@/features/repository/repository-copy";
import { deriveTaskKey } from "@/features/hierarchy/create-project-page";

const goTo = vi.hoisted(() => vi.fn());
vi.mock("@/features/repository/redirect", () => ({ goTo }));

const apiUrl = "http://localhost:8801/api/v1";
const organizationId = organization().id;
const created = project({
  id: "00000000-0000-4000-8000-0000000000c1",
  name: "Mobile app"
});
const authorizationId = "ra_abcdefghijklmnopqrstuvwx";

function providers(githubConfigured = true): RequestHandler {
  return http.get(`${apiUrl}/repository/providers`, () =>
    HttpResponse.json({
      providers: [
        {
          provider: "github",
          configured: githubConfigured,
          unavailable_reason: githubConfigured
            ? null
            : "GitHub isn’t set up on this server."
        },
        {
          provider: "gitlab",
          configured: false,
          unavailable_reason: "GitLab isn’t set up on this server."
        }
      ]
    })
  );
}

function createHandler(bodies: unknown[]): RequestHandler {
  return http.post(
    `${apiUrl}/organizations/:organizationId/projects`,
    async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json(created, { status: 201 });
    }
  );
}

function render(extra: RequestHandler[]) {
  return renderDashboardRoute({
    path: `/organizations/${organizationId}/projects/new`,
    auth: new Auth({ status: "signedIn", identityKey: "user" }),
    platform: platform(),
    handlers: [...extra, ...handlers]
  });
}

afterEach(() => {
  goTo.mockReset();
  window.sessionStorage.clear();
});

describe("create project page", () => {
  it("derives the task key the way the API does", () => {
    expect(deriveTaskKey("Mobile app")).toBe("MOB");
    expect(deriveTaskKey("  q ")).toBe("PRJ");
    expect(deriveTaskKey("A1 tools")).toBe("A1T");
  });

  it("creates an empty project in this organization and opens it", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const view = await render([providers(false), createHandler(bodies)]);
    await screen.findByText("GitHub isn’t set up on this server.");
    expect(
      screen.getByRole("button", { name: "Create and connect GitHub" })
    ).toBeDisabled();
    await user.type(screen.getByLabelText("Project name"), "Mobile app");
    expect(screen.getByLabelText("Task key")).toHaveValue("MOB");
    await user.type(
      screen.getByLabelText("Description (optional)"),
      "iOS and Android"
    );
    await user.click(
      screen.getByRole("button", { name: "Create empty project" })
    );
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/projects/${created.id}/overview`
      )
    );
    expect(bodies).toEqual([
      {
        name: "Mobile app",
        description: "iOS and Android",
        task_key_prefix: "MOB"
      }
    ]);
  });

  it("validates the name and a custom task key before creating", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await render([providers(), createHandler(bodies)]);
    await user.click(
      await screen.findByRole("button", { name: "Create empty project" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a project name."
    );
    await user.type(screen.getByLabelText("Project name"), "Mobile app");
    await user.clear(screen.getByLabelText("Task key"));
    await user.type(screen.getByLabelText("Task key"), "m");
    await user.click(
      screen.getByRole("button", { name: "Create empty project" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Task key must be 2–8 letters or digits."
    );
    expect(bodies).toEqual([]);
  });

  it("creates the project, then sends the person to the provider with the connect page as the return", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const authorizations: unknown[] = [];
    await render([
      providers(),
      createHandler(bodies),
      http.post(
        `${apiUrl}/projects/:projectId/repository/authorizations`,
        async ({ request, params }) => {
          authorizations.push({
            projectId: params.projectId,
            body: await request.json()
          });
          return HttpResponse.json({
            authorization_id: authorizationId,
            authorize_url: "https://github.com/login/oauth/authorize?state=x",
            expires_at: "2026-10-07T06:00:00.000Z"
          });
        }
      )
    ]);
    await user.type(await screen.findByLabelText("Project name"), "Mobile app");
    await user.click(
      await screen.findByRole("button", { name: "Create and connect GitHub" })
    );
    await waitFor(() =>
      expect(goTo).toHaveBeenCalledWith(
        "https://github.com/login/oauth/authorize?state=x"
      )
    );
    expect(authorizations).toEqual([
      {
        projectId: created.id,
        body: {
          provider: "github",
          return_path: `/projects/${created.id}/connect`
        }
      }
    ]);
    expect(
      JSON.parse(window.sessionStorage.getItem(REPOSITORY_ATTEMPT_KEY) ?? "")
    ).toEqual({
      authorization_id: authorizationId,
      project_id: created.id,
      provider: "github"
    });
  });

  it("keeps the project and shows the connect page when the provider can't start", async () => {
    const user = userEvent.setup();
    const view = await render([
      providers(),
      createHandler([]),
      http.post(`${apiUrl}/projects/:projectId/repository/authorizations`, () =>
        HttpResponse.json(
          {
            error: {
              code: "REPOSITORY_NOT_CONFIGURED",
              message: "Not configured.",
              request_id: "req_1"
            }
          },
          { status: 400 }
        )
      )
    ]);
    await user.type(await screen.findByLabelText("Project name"), "Mobile app");
    await user.click(
      await screen.findByRole("button", { name: "Create and connect GitHub" })
    );
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/projects/${created.id}/connect`
      )
    );
    expect(view.router.state.location.search).toMatchObject({
      repository_error: "authorization_failed"
    });
    expect(goTo).not.toHaveBeenCalled();
  });
});
