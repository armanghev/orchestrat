import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, type RequestHandler } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OrganizationIntegration,
  OrganizationRepository
} from "@orchestrat/protocol";
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

function render(extra: RequestHandler[], search = "") {
  return renderDashboardRoute({
    path: `/organizations/${organizationId}/projects/new${search}`,
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
    await waitFor(
      () =>
        expect(view.router.state.location.pathname).toBe(
          `/projects/${created.id}/overview`
        ),
      { timeout: 5000 }
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
    await waitFor(
      () =>
        expect(goTo).toHaveBeenCalledWith(
          "https://github.com/login/oauth/authorize?state=x"
        ),
      { timeout: 5000 }
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
    await waitFor(
      () =>
        expect(view.router.state.location.pathname).toBe(
          `/projects/${created.id}/connect`
        ),
      { timeout: 5000 }
    );
    expect(view.router.state.location.search).toMatchObject({
      repository_error: "authorization_failed"
    });
    expect(goTo).not.toHaveBeenCalled();
  });
});

const integration: OrganizationIntegration = {
  id: "00000000-0000-4000-8000-000000000701",
  organization_id: organizationId,
  provider: "gitlab",
  account_name: "acme",
  account_type: "User",
  repository_selection: "all",
  selected_repository_ids: [],
  repository_count: 2,
  status: "active",
  status_reason: null,
  manage_url: null,
  connected_by_user_id: null,
  last_synced_at: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z"
};

function repository(
  overrides: Partial<OrganizationRepository> = {}
): OrganizationRepository {
  return {
    id: "00000000-0000-4000-8000-000000000801",
    integration_id: integration.id,
    provider: "gitlab",
    provider_repository_id: "11",
    full_name: "acme/mobile-app",
    url: null,
    default_branch: "main",
    pushed_at: "2026-10-05T00:00:00.000Z",
    first_seen_at: "2026-10-01T00:00:00.000Z",
    is_new: true,
    project_id: null,
    dismissed: false,
    ...overrides
  };
}
const otherRepository = repository({
  id: "00000000-0000-4000-8000-000000000802",
  provider_repository_id: "12",
  full_name: "acme/website",
  pushed_at: "2026-10-04T00:00:00.000Z"
});

function importSources(): RequestHandler[] {
  return [
    http.get(`${apiUrl}/organizations/:organizationId/integrations`, () =>
      HttpResponse.json({ integrations: [integration] })
    ),
    http.get(`${apiUrl}/organizations/:organizationId/repositories`, () =>
      HttpResponse.json({ repositories: [repository(), otherRepository] })
    )
  ];
}

function connection(projectId: string) {
  return {
    id: "00000000-0000-4000-8000-000000000501",
    project_id: projectId,
    provider: "gitlab",
    provider_repository_id: "11",
    full_name: "acme/mobile-app",
    url: null,
    provider_default_branch: "main",
    status: "active",
    status_reason: null,
    last_event_at: null,
    last_reconciled_at: null,
    connected_by_user_id: null,
    hook_health: null,
    failed_delivery_count: 0,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z"
  };
}

describe("create project page import mode", () => {
  it("lists importable repositories as the source and selecting one enters import mode", async () => {
    const user = userEvent.setup();
    const view = await render([providers(), ...importSources()]);
    const list = await screen.findByRole("list", {
      name: "Repositories to import"
    });
    expect(
      screen.queryByRole("button", { name: "Create and connect GitHub" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Connect another account" })
    ).toHaveAttribute("href", `/organizations/${organizationId}/integrations`);
    await user.type(screen.getByLabelText("Search repositories"), "web");
    expect(within(list).queryByText("acme/mobile-app")).not.toBeInTheDocument();
    await user.click(
      within(list).getByRole("button", { name: "Import acme/website" })
    );
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        repository: otherRepository.id
      })
    );
    expect(
      await screen.findByText(/Importing/, { selector: "p" })
    ).toHaveTextContent("Importing acme/website from GitLab.com");
    expect(screen.getByLabelText("Project name")).toHaveValue("website");
  });

  it("prefills from the repository, keeps edits, and imports", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    const view = await render(
      [
        providers(),
        ...importSources(),
        http.post(
          `${apiUrl}/organizations/:organizationId/projects/import`,
          async ({ request }) => {
            bodies.push(await request.json());
            return HttpResponse.json(
              { project: created, repository: connection(created.id) },
              { status: 201 }
            );
          }
        )
      ],
      `?repository=${repository().id}`
    );
    expect(
      await screen.findByText(/Importing/, { selector: "p" })
    ).toHaveTextContent("Importing acme/mobile-app from GitLab.com");
    expect(screen.getByLabelText("Project name")).toHaveValue("mobile-app");
    expect(screen.getByLabelText("Task key")).toHaveValue("MOB");
    await user.clear(screen.getByLabelText("Project name"));
    await user.type(screen.getByLabelText("Project name"), "Phone");
    expect(screen.getByLabelText("Task key")).toHaveValue("PHO");
    await user.type(
      screen.getByLabelText("Description (optional)"),
      "iOS and Android"
    );
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(
      () =>
        expect(view.router.state.location.pathname).toBe(
          `/projects/${created.id}/overview`
        ),
      { timeout: 5000 }
    );
    expect(bodies).toEqual([
      {
        repository_id: repository().id,
        name: "Phone",
        description: "iOS and Android",
        task_key_prefix: "PHO"
      }
    ]);
  });

  it("says when the repository is already a project", async () => {
    const user = userEvent.setup();
    await render(
      [
        providers(),
        ...importSources(),
        http.post(
          `${apiUrl}/organizations/:organizationId/projects/import`,
          () =>
            HttpResponse.json(
              {
                error: {
                  code: "REPOSITORY_CONNECTION_EXISTS",
                  message: "Connected already.",
                  details: {},
                  request_id: "req_1"
                }
              },
              { status: 409 }
            )
        )
      ],
      `?repository=${repository().id}`
    );
    await screen.findByText(/Importing/, { selector: "p" });
    await user.click(screen.getByRole("button", { name: "Import" }));
    const card = screen.getByRole("region", { name: "Repository to import" });
    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "That repository is already a project."
    );
  });

  it("keeps the provider rows and points to Integrations without integrations", async () => {
    await render([providers()]);
    expect(
      await screen.findByRole("button", { name: "Create and connect GitHub" })
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Integrations" })).toHaveAttribute(
      "href",
      `/organizations/${organizationId}/integrations`
    );
  });
});
