import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { project } from "@/test/factories";
import {
  apiUrl,
  branchHandlers,
  projectId,
  render
} from "@/test/branch-routes";

// Installing the GitHub App mid-connection: the picker offers the install, and
// the Setup URL finds the attempt on the server when it opens in another
// browser.

const goTo = vi.hoisted(() => vi.fn());
vi.mock("@/features/repository/redirect", () => ({ goTo }));

const authorizationId = "ra_abcdefghijklmnopqrstuvwx";
const installUrl =
  "https://github.com/apps/orchestrat/installations/new?state=ra_abcdefghijklmnopqrstuvwx";

const settings = (repositories: unknown[]) => [
  http.get(`${apiUrl}/organizations/:organizationId/projects`, () =>
    HttpResponse.json({ projects: [project({ role: "owner" })] })
  ),
  http.get(`${apiUrl}/projects/:projectId/members`, () =>
    HttpResponse.json({ members: [] })
  ),
  http.get(`${apiUrl}/projects/:projectId/invitations`, () =>
    HttpResponse.json({ invitations: [] })
  ),
  http.get(`${apiUrl}/projects/:projectId/repository`, () =>
    HttpResponse.json({
      repository: null,
      providers: [
        { provider: "github", configured: true, unavailable_reason: null }
      ]
    })
  ),
  http.get(
    `${apiUrl}/projects/:projectId/repository/authorizations/:authorizationId/repositories`,
    () => HttpResponse.json({ repositories, install_url: installUrl })
  ),
  ...branchHandlers()
];

afterEach(() => {
  goTo.mockReset();
  window.sessionStorage.clear();
});

describe("GitHub App installs", () => {
  it("offers to install the app when no repository is listed", async () => {
    await render(
      `/projects/${projectId}/settings?repository_authorization=${authorizationId}`,
      settings([])
    );
    expect(
      await screen.findByText(
        "The GitHub App isn’t installed where you have repositories yet."
      )
    ).toBeVisible();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Install the GitHub App" })
    );
    expect(goTo).toHaveBeenCalledWith(installUrl);
  });

  it("finds the attempt on the server when the install opened elsewhere", async () => {
    let body: unknown;
    const view = await render("/repository/github/setup?installation_id=4242", [
      http.get(`${apiUrl}/repository/authorizations/pending`, ({ request }) => {
        expect(new URL(request.url).searchParams.get("provider")).toBe(
          "github"
        );
        return HttpResponse.json({
          authorization_id: authorizationId,
          project_id: projectId,
          provider: "github",
          expires_at: "2026-09-30T10:00:00.000Z"
        });
      }),
      http.post(
        `${apiUrl}/projects/:projectId/repository/authorizations/:authorizationId/github-installation`,
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ next: "pick_repository" });
        }
      ),
      ...settings([
        {
          provider_repository_id: "101",
          full_name: "acme/app",
          default_branch: "main",
          eligible: true,
          ineligible_reason: null
        }
      ])
    ]);
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        repository_authorization: authorizationId
      })
    );
    expect(body).toEqual({ installation_id: "4242" });
    expect(
      await screen.findByRole("dialog", { name: "Choose a repository" })
    ).toBeVisible();
  });

  it.each([
    { source: "installation", returnPath: `/projects/${projectId}/connect` },
    { source: "installation", returnPath: `/projects/${projectId}/overview` },
    {
      source: "installation",
      returnPath: `/projects/${projectId}/settings?repository_error=expired`
    },
    { source: "pending", returnPath: `/projects/${projectId}/overview` }
  ])(
    "honors the $source return path $returnPath",
    async ({ source, returnPath }) => {
      const view = await render(
        "/repository/github/setup?installation_id=4242",
        [
          http.get(`${apiUrl}/repository/authorizations/pending`, () =>
            HttpResponse.json({
              authorization_id: authorizationId,
              project_id: projectId,
              provider: "github",
              expires_at: "2026-10-30T10:00:00.000Z",
              return_path:
                source === "pending"
                  ? returnPath
                  : `/projects/${projectId}/settings`
            })
          ),
          http.post(
            `${apiUrl}/projects/:projectId/repository/authorizations/:authorizationId/github-installation`,
            () =>
              HttpResponse.json({
                next: "pick_repository",
                ...(source === "installation"
                  ? { return_path: returnPath }
                  : {})
              })
          ),
          ...settings([])
        ]
      );
      await waitFor(() =>
        expect(view.router.state.location.pathname).toBe(
          returnPath.split("?")[0]
        )
      );
      const search = new URLSearchParams(view.router.state.location.searchStr);
      expect(search.get("repository_authorization")).toBe(authorizationId);
      if (returnPath.includes("?"))
        expect(search.get("repository_error")).toBe("expired");
    }
  );

  it("explains when no connection is in progress", async () => {
    await render("/repository/github/setup?installation_id=4242", [
      http.get(`${apiUrl}/repository/authorizations/pending`, () =>
        HttpResponse.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "No connection in progress.",
              request_id: "req_1",
              details: {}
            }
          },
          { status: 404 }
        )
      ),
      ...settings([])
    ]);
    expect(
      await screen.findByText(
        /There’s no GitHub connection in progress for your account/
      )
    ).toBeVisible();
  });
});
