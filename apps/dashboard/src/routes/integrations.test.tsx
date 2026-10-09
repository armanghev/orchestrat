import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, type RequestHandler } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OrganizationIntegration,
  OrganizationRepository
} from "@orchestrat/protocol";
import { apiUrl, render } from "@/test/branch-routes";
import { organization } from "@/test/factories";
import { handlers } from "@/test/handlers";
import { REPOSITORY_ATTEMPT_KEY } from "@/features/repository/repository-copy";

const goTo = vi.hoisted(() => vi.fn());
vi.mock("@/features/repository/redirect", () => ({ goTo }));

// Radix radios inside a form measure themselves.
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserver);

const org = organization();
const path = `/organizations/${org.id}/integrations`;
const authorizationId = "ra_abcdefghijklmnopqrstuvwx";

function integration(
  overrides: Partial<OrganizationIntegration> = {}
): OrganizationIntegration {
  return {
    id: "00000000-0000-4000-8000-000000000701",
    organization_id: org.id,
    provider: "github",
    account_name: "acme",
    account_type: "Organization",
    repository_selection: "all",
    selected_repository_ids: [],
    repository_count: 12,
    status: "active",
    status_reason: null,
    manage_url:
      "https://github.com/organizations/acme/settings/installations/1",
    connected_by_user_id: null,
    last_synced_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

const gitlab = integration({
  id: "00000000-0000-4000-8000-000000000702",
  provider: "gitlab",
  account_name: "jane",
  account_type: "User",
  repository_selection: "selected",
  selected_repository_ids: ["11", "12"],
  repository_count: 2,
  manage_url: null
});

function repository(
  overrides: Partial<OrganizationRepository> = {}
): OrganizationRepository {
  return {
    id: "00000000-0000-4000-8000-000000000801",
    integration_id: gitlab.id,
    provider: "gitlab",
    provider_repository_id: "11",
    full_name: "jane/api",
    url: null,
    default_branch: "main",
    pushed_at: null,
    first_seen_at: "2026-10-01T00:00:00.000Z",
    is_new: false,
    project_id: null,
    dismissed: false,
    ...overrides
  };
}

function providers({ gitlab = true } = {}): RequestHandler {
  return http.get(`${apiUrl}/repository/providers`, () =>
    HttpResponse.json({
      providers: [
        { provider: "github", configured: true, unavailable_reason: null },
        {
          provider: "gitlab",
          configured: gitlab,
          unavailable_reason: gitlab
            ? null
            : "GitLab isn’t set up on this server."
        },
        { provider: "origin", configured: true, unavailable_reason: null }
      ]
    })
  );
}

function list(integrations: OrganizationIntegration[]): RequestHandler {
  return http.get(`${apiUrl}/organizations/:organizationId/integrations`, () =>
    HttpResponse.json({ integrations })
  );
}

function setup(extra: RequestHandler[], at = path) {
  return render(at, [...extra, ...handlers]);
}

afterEach(() => {
  goTo.mockReset();
  window.sessionStorage.clear();
});

describe("organization integrations page", () => {
  it("lists connected accounts per provider with status in words", async () => {
    await setup([
      providers(),
      list([
        integration({
          status: "needs_reauthorization",
          status_reason: "GitHub revoked the app’s access."
        }),
        gitlab
      ])
    ]);
    const github = await screen.findByRole("region", { name: "GitHub" });
    expect(within(github).getByText("acme")).toBeVisible();
    expect(within(github).getByText("All repositories")).toBeVisible();
    expect(within(github).getByText("12 repositories")).toBeVisible();
    expect(within(github).getByText("Synced 5 min ago")).toBeVisible();
    expect(within(github).getByText("Needs reauthorization.")).toBeVisible();
    expect(
      within(github).getByText("GitHub revoked the app’s access.")
    ).toBeVisible();
    expect(
      within(github).getByRole("link", { name: "Manage on GitHub (acme)" })
    ).toHaveAttribute(
      "href",
      "https://github.com/organizations/acme/settings/installations/1"
    );
    const gitlabSection = screen.getByRole("region", { name: "GitLab.com" });
    expect(
      within(gitlabSection).getByText("Selected repositories (2)")
    ).toBeVisible();
    expect(
      within(gitlabSection).getByRole("button", {
        name: "Edit access for jane"
      })
    ).toBeVisible();
    expect(
      within(gitlabSection).queryByRole("link", { name: /Manage on GitHub/ })
    ).not.toBeInTheDocument();
  });

  it("shows one Connect action per empty provider and disables an unconfigured one", async () => {
    await setup([providers({ gitlab: false }), list([])]);
    expect(
      await screen.findByText("No GitHub accounts connected")
    ).toBeVisible();
    expect(screen.getByText("No GitLab.com accounts connected")).toBeVisible();
    expect(
      await screen.findByText("GitLab isn’t set up on this server.")
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Connect GitLab" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Connect GitHub" })
    ).toBeEnabled();
  });

  it("starts GitHub with the integrations page as the return and records the attempt", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    await setup([
      providers(),
      list([]),
      http.post(
        `${apiUrl}/organizations/:organizationId/integrations/authorizations`,
        async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json({
            authorization_id: authorizationId,
            authorize_url: "https://github.com/login/oauth/authorize?state=x",
            expires_at: "2026-10-08T06:00:00.000Z"
          });
        }
      )
    ]);
    await user.click(
      await screen.findByRole("button", { name: "Connect GitHub" })
    );
    await waitFor(() =>
      expect(goTo).toHaveBeenCalledWith(
        "https://github.com/login/oauth/authorize?state=x"
      )
    );
    expect(bodies).toEqual([
      {
        provider: "github",
        return_path: `/organizations/${org.id}/integrations`
      }
    ]);
    expect(
      JSON.parse(window.sessionStorage.getItem(REPOSITORY_ATTEMPT_KEY) ?? "")
    ).toEqual({
      authorization_id: authorizationId,
      organization_id: org.id,
      project_id: null,
      provider: "github",
      return_path: `/organizations/${org.id}/integrations`
    });
  });

  it("offers GitHub installations after the provider returns and connects one", async () => {
    const user = userEvent.setup();
    const created: unknown[] = [];
    let integrations: OrganizationIntegration[] = [];
    const view = await setup(
      [
        providers(),
        http.get(`${apiUrl}/organizations/:organizationId/integrations`, () =>
          HttpResponse.json({ integrations })
        ),
        http.get(
          `${apiUrl}/organizations/:organizationId/integrations/authorizations/:authorizationId`,
          () =>
            HttpResponse.json({
              provider: "github",
              installations: [
                {
                  installation_id: "1",
                  account_name: "acme",
                  account_type: "Organization",
                  repository_selection: "all",
                  connected: true
                },
                {
                  installation_id: "2",
                  account_name: "jane",
                  account_type: "User",
                  repository_selection: "selected",
                  connected: false
                }
              ],
              install_url:
                "https://github.com/apps/orchestrat/installations/new",
              repositories: []
            })
        ),
        http.post(
          `${apiUrl}/organizations/:organizationId/integrations`,
          async ({ request }) => {
            created.push(await request.json());
            integrations = [
              integration({ account_name: "jane", account_type: "User" })
            ];
            return HttpResponse.json(
              { integration: integrations[0] },
              { status: 201 }
            );
          }
        )
      ],
      `${path}?repository_authorization=${authorizationId}`
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Choose a GitHub account"
    });
    expect(await within(dialog).findByText("Connected")).toBeVisible();
    expect(within(dialog).getByText("Selected repositories")).toBeVisible();
    expect(
      within(dialog).queryByRole("button", { name: "Connect acme" })
    ).not.toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Connect jane" })
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Choose a GitHub account" })
      ).not.toBeInTheDocument()
    );
    expect(created).toEqual([
      {
        provider: "github",
        authorization_id: authorizationId,
        installation_id: "2"
      }
    ]);
    expect(view.router.state.location.search).toEqual({});
    const github = screen.getByRole("region", { name: "GitHub" });
    expect(await within(github).findByText("jane")).toBeVisible();
  });

  it("sends Install on another account to GitHub after recording the attempt", async () => {
    const user = userEvent.setup();
    await setup(
      [
        providers(),
        list([]),
        http.get(
          `${apiUrl}/organizations/:organizationId/integrations/authorizations/:authorizationId`,
          () =>
            HttpResponse.json({
              provider: "github",
              installations: [],
              install_url:
                "https://github.com/apps/orchestrat/installations/new",
              repositories: []
            })
        )
      ],
      `${path}?repository_authorization=${authorizationId}`
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Choose a GitHub account"
    });
    await user.click(
      await within(dialog).findByRole("button", {
        name: "Install on another account"
      })
    );
    expect(goTo).toHaveBeenCalledWith(
      "https://github.com/apps/orchestrat/installations/new"
    );
    expect(
      JSON.parse(window.sessionStorage.getItem(REPOSITORY_ATTEMPT_KEY) ?? "")
    ).toMatchObject({
      authorization_id: authorizationId,
      organization_id: org.id,
      project_id: null,
      provider: "github"
    });
  });

  it("connects GitLab with only the selected eligible projects", async () => {
    const user = userEvent.setup();
    const created: unknown[] = [];
    await setup(
      [
        providers(),
        list([]),
        http.get(
          `${apiUrl}/organizations/:organizationId/integrations/authorizations/:authorizationId`,
          () =>
            HttpResponse.json({
              provider: "gitlab",
              installations: [],
              install_url: null,
              repositories: [
                {
                  provider_repository_id: "11",
                  full_name: "jane/api",
                  default_branch: "main",
                  eligible: true,
                  ineligible_reason: null
                },
                {
                  provider_repository_id: "12",
                  full_name: "jane/web",
                  default_branch: "main",
                  eligible: true,
                  ineligible_reason: null
                },
                {
                  provider_repository_id: "13",
                  full_name: "jane/mirror",
                  default_branch: "main",
                  eligible: false,
                  ineligible_reason: "Mirrors can’t be connected."
                }
              ]
            })
        ),
        http.post(
          `${apiUrl}/organizations/:organizationId/integrations`,
          async ({ request }) => {
            created.push(await request.json());
            return HttpResponse.json({ integration: gitlab }, { status: 201 });
          }
        )
      ],
      `${path}?repository_authorization=${authorizationId}`
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Choose GitLab access"
    });
    await user.click(
      within(dialog).getByRole("radio", { name: "Only selected projects" })
    );
    const submit = within(dialog).getByRole("button", {
      name: "Connect GitLab"
    });
    expect(submit).toBeDisabled();
    expect(within(dialog).queryByText("jane/mirror")).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Search projects"), "web");
    expect(within(dialog).queryByText("jane/api")).not.toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("checkbox", { name: "jane/web" })
    );
    await user.click(submit);
    await waitFor(() =>
      expect(created).toEqual([
        {
          provider: "gitlab",
          authorization_id: authorizationId,
          repository_selection: "selected",
          selected_repository_ids: ["12"]
        }
      ])
    );
  });

  it("edits GitLab access from the known repositories", async () => {
    const user = userEvent.setup();
    const updates: unknown[] = [];
    await setup([
      providers(),
      list([gitlab]),
      http.get(`${apiUrl}/organizations/:organizationId/repositories`, () =>
        HttpResponse.json({
          repositories: [
            repository(),
            repository({
              id: "00000000-0000-4000-8000-000000000802",
              provider_repository_id: "12",
              full_name: "jane/web"
            })
          ]
        })
      ),
      http.patch(
        `${apiUrl}/organizations/:organizationId/integrations/:integrationId`,
        async ({ request }) => {
          updates.push(await request.json());
          return HttpResponse.json({ integration: gitlab });
        }
      )
    ]);
    await user.click(
      await screen.findByRole("button", { name: "Edit access for jane" })
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Choose GitLab access"
    });
    const api = await within(dialog).findByRole("checkbox", {
      name: "jane/api"
    });
    expect(api).toBeChecked();
    await user.click(api);
    await user.click(
      within(dialog).getByRole("button", { name: "Save access" })
    );
    await waitFor(() =>
      expect(updates).toEqual([
        { repository_selection: "selected", selected_repository_ids: ["12"] }
      ])
    );
  });

  it("explains why a GitLab account still used by projects can't be removed", async () => {
    const user = userEvent.setup();
    await setup([
      providers(),
      list([gitlab]),
      http.delete(
        `${apiUrl}/organizations/:organizationId/integrations/:integrationId`,
        () =>
          HttpResponse.json(
            {
              error: {
                code: "INTEGRATION_IN_USE",
                message: "2 projects still use this GitLab account.",
                details: {},
                request_id: "req_1"
              }
            },
            { status: 409 }
          )
      )
    ]);
    await user.click(
      await screen.findByRole("button", { name: "Remove jane" })
    );
    const dialog = await screen.findByRole("dialog", { name: "Remove jane?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "2 projects still use this GitLab account."
    );
  });

  it("refreshes an account", async () => {
    const user = userEvent.setup();
    const refreshed: string[] = [];
    await setup([
      providers(),
      list([integration()]),
      http.post(
        `${apiUrl}/organizations/:organizationId/integrations/:integrationId/refresh`,
        ({ params }) => {
          refreshed.push(String(params.integrationId));
          return HttpResponse.json({ integration: integration() });
        }
      )
    ]);
    await user.click(
      await screen.findByRole("button", { name: "Refresh acme" })
    );
    await waitFor(() => expect(refreshed).toEqual([integration().id]));
  });

  it("explains a failed provider return and tries the same provider again", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    window.sessionStorage.setItem(
      REPOSITORY_ATTEMPT_KEY,
      JSON.stringify({
        authorization_id: authorizationId,
        organization_id: org.id,
        project_id: null,
        provider: "gitlab",
        return_path: path
      })
    );
    await setup(
      [
        providers(),
        list([]),
        http.post(
          `${apiUrl}/organizations/:organizationId/integrations/authorizations`,
          async ({ request }) => {
            bodies.push(await request.json());
            return HttpResponse.json({
              authorization_id: authorizationId,
              authorize_url: "https://gitlab.com/oauth/authorize?state=y",
              expires_at: "2026-10-08T06:00:00.000Z"
            });
          }
        )
      ],
      `${path}?repository_error=expired`
    );
    expect(
      await screen.findByText(
        "Connecting took too long and the link expired. Start again."
      )
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(goTo).toHaveBeenCalledWith(
        "https://gitlab.com/oauth/authorize?state=y"
      )
    );
    expect(bodies).toEqual([{ provider: "gitlab", return_path: path }]);
  });

  it("shows members a read-only note without calling the API", async () => {
    let requested = false;
    await setup([
      http.get(`${apiUrl}/organizations`, () =>
        HttpResponse.json({
          organizations: [organization({ role: "member" })]
        })
      ),
      http.get(`${apiUrl}/organizations/:organizationId/integrations`, () => {
        requested = true;
        return HttpResponse.json({ integrations: [] });
      })
    ]);
    expect(
      await screen.findByText(/Only owners and admins of Acme Corporation/)
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Connect GitHub" })
    ).not.toBeInTheDocument();
    expect(requested).toBe(false);
  });
});
