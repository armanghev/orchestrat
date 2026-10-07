import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, type RequestHandler } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Branch, RepositoryConnection } from "@orchestrat/protocol";
import { branch, project, taskCard } from "@/test/factories";
import {
  apiUrl,
  branchHandlers,
  main,
  projectId,
  render
} from "@/test/branch-routes";
import { REPOSITORY_ATTEMPT_KEY } from "@/features/repository/repository-copy";

const goTo = vi.hoisted(() => vi.fn());
vi.mock("@/features/repository/redirect", () => ({ goTo }));

const authorizationId = "ra_abcdefghijklmnopqrstuvwx";
const trunk = branch({
  id: "00000000-0000-4000-8000-000000000055",
  name: "trunk",
  is_default: false,
  name_source: "cli",
  created_via: "cli"
});

function connection(
  overrides: Partial<RepositoryConnection> = {}
): RepositoryConnection {
  return {
    id: "00000000-0000-4000-8000-000000000501",
    project_id: projectId,
    provider: "github",
    provider_repository_id: "101",
    full_name: "acme/app",
    url: "https://github.com/acme/app",
    provider_default_branch: "main",
    status: "active",
    status_reason: null,
    last_event_at: "2026-09-30T08:00:00.000Z",
    last_reconciled_at: "2026-09-30T08:05:00.000Z",
    connected_by_user_id: null,
    hook_health: null,
    failed_delivery_count: 0,
    created_at: "2026-09-29T00:00:00.000Z",
    updated_at: "2026-09-30T08:05:00.000Z",
    ...overrides
  };
}

const providers = [
  { provider: "github", configured: true, unavailable_reason: null },
  {
    provider: "gitlab",
    configured: false,
    unavailable_reason: "GitLab isn’t set up on this server."
  },
  { provider: "origin", configured: true, unavailable_reason: null }
];

function connectHandlers({
  role = "owner",
  repository = null,
  branches = [main],
  extra = []
}: {
  role?: "owner" | "member";
  repository?:
    RepositoryConnection | null | (() => RepositoryConnection | null);
  branches?: Branch[];
  extra?: RequestHandler[];
} = {}) {
  return [
    ...extra,
    http.get(`${apiUrl}/organizations/:organizationId/projects`, () =>
      HttpResponse.json({ projects: [project({ role })] })
    ),
    http.get(`${apiUrl}/projects/:projectId/members`, () =>
      HttpResponse.json({ members: [] })
    ),
    http.get(`${apiUrl}/projects/:projectId/invitations`, () =>
      HttpResponse.json({ invitations: [] })
    ),
    http.get(`${apiUrl}/projects/:projectId/repository`, () =>
      HttpResponse.json({
        repository:
          typeof repository === "function" ? repository() : repository,
        providers
      })
    ),
    ...branchHandlers({ branches })
  ];
}

const candidates = (defaultBranch: string | null) =>
  http.get(
    `${apiUrl}/projects/:projectId/repository/authorizations/:authorizationId/repositories`,
    () =>
      HttpResponse.json({
        repositories: [
          {
            provider_repository_id: "101",
            full_name: "acme/app",
            default_branch: defaultBranch,
            eligible: true,
            ineligible_reason: null
          },
          {
            provider_repository_id: "102",
            full_name: "acme/mirror",
            default_branch: "main",
            eligible: false,
            ineligible_reason: "GitHub mirrors can’t be connected."
          }
        ]
      })
  );

describe("repository connect page", () => {
  afterEach(() => {
    goTo.mockReset();
    window.sessionStorage.clear();
  });

  it("shows a loading skeleton while the repository query is pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await render(
      `/projects/${projectId}/connect`,
      connectHandlers({
        extra: [
          http.get(`${apiUrl}/projects/:projectId/repository`, async () => {
            await gate;
            return HttpResponse.json({ repository: null, providers });
          })
        ]
      })
    );
    expect(
      await screen.findByRole("status", {
        name: "Loading the repository connection"
      })
    ).toBeVisible();
    release();
    expect(
      await screen.findByRole("heading", { name: "Not connected" })
    ).toBeVisible();
  });

  it("shows Not connected with provider actions when authorization is missing", async () => {
    await render(`/projects/${projectId}/connect`, connectHandlers());
    expect(
      await screen.findByRole("heading", { name: "Not connected" })
    ).toBeVisible();
    expect(
      screen.getByText(
        "No repository authorization is ready for this project yet."
      )
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Connect GitHub" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeVisible();
  });

  it("explains a failed provider redirect and retries with return_path /connect", async () => {
    window.sessionStorage.setItem(
      REPOSITORY_ATTEMPT_KEY,
      JSON.stringify({
        authorization_id: authorizationId,
        project_id: projectId,
        provider: "github"
      })
    );
    let body: unknown;
    await render(
      `/projects/${projectId}/connect?repository_error=expired`,
      connectHandlers({
        extra: [
          http.post(
            `${apiUrl}/projects/:projectId/repository/authorizations`,
            async ({ request }) => {
              body = await request.json();
              return HttpResponse.json({
                authorization_id: authorizationId,
                authorize_url: "https://github.com/login/oauth/authorize?x=1",
                expires_at: "2026-09-30T10:00:00.000Z"
              });
            }
          )
        ]
      })
    );
    expect(
      await screen.findByText(
        "Connecting took too long and the link expired. Start again."
      )
    ).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(goTo).toHaveBeenCalledWith(
        "https://github.com/login/oauth/authorize?x=1"
      )
    );
    expect(body).toEqual({
      provider: "github",
      return_path: `/projects/${projectId}/connect`
    });
  });

  it("lets members read the page without connect actions", async () => {
    await render(
      `/projects/${projectId}/connect`,
      connectHandlers({ role: "member" })
    );
    expect(
      await screen.findByText(
        "Only project owners and admins can connect a repository."
      )
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Connect / })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeVisible();
  });

  it("redirects to overview when a repository is already connected", async () => {
    const view = await render(
      `/projects/${projectId}/connect`,
      connectHandlers({ repository: connection() })
    );
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/projects/${projectId}/overview`
      )
    );
  });

  it("picks a repository, connects, and goes to overview", async () => {
    let body: unknown;
    let connected: RepositoryConnection | null = null;
    const view = await render(
      `/projects/${projectId}/connect?repository_authorization=${authorizationId}`,
      connectHandlers({
        repository: () => connected,
        extra: [
          candidates("trunk"),
          http.post(
            `${apiUrl}/projects/:projectId/repository`,
            async ({ request }) => {
              body = await request.json();
              connected = connection({ provider_default_branch: "trunk" });
              return HttpResponse.json(
                { repository: connected },
                { status: 201 }
              );
            }
          )
        ]
      })
    );
    expect(
      await screen.findByRole("heading", { name: "Choose a repository" })
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: /acme\/app/ }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      await screen.findByRole("heading", { name: "Default branch" })
    ).toBeVisible();
    expect(screen.getByText(/will be renamed to/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/projects/${projectId}/overview`
      )
    );
    expect(body).toEqual({
      authorization_id: authorizationId,
      provider_repository_id: "101",
      default_branch_mapping: { mode: "rename_default" },
      create_existing_branches: false
    });
  });

  it("skips for now to the overview", async () => {
    const view = await render(
      `/projects/${projectId}/connect?repository_authorization=${authorizationId}`,
      connectHandlers({ extra: [candidates("main")] })
    );
    await screen.findByRole("heading", { name: "Choose a repository" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/projects/${projectId}/overview`
      )
    );
  });

  it("asks which branch wins when one already has the provider's name", async () => {
    let body: Record<string, unknown> | undefined;
    await render(
      `/projects/${projectId}/connect?repository_authorization=${authorizationId}`,
      connectHandlers({
        branches: [main, trunk],
        extra: [
          candidates("trunk"),
          http.get(`${apiUrl}/projects/:projectId/tasks`, ({ request }) =>
            new URL(request.url).searchParams.get("branch_id") === trunk.id
              ? HttpResponse.json({
                  tasks: [taskCard({ branch_id: trunk.id })],
                  total: 1,
                  next_cursor: null
                })
              : HttpResponse.json({ tasks: [], total: 0, next_cursor: null })
          ),
          http.post(
            `${apiUrl}/projects/:projectId/repository`,
            async ({ request }) => {
              body = (await request.json()) as Record<string, unknown>;
              return HttpResponse.json(
                { repository: connection() },
                { status: 201 }
              );
            }
          )
        ]
      })
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /acme\/app/ }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    const page = screen
      .getByRole("heading", { name: "Default branch" })
      .closest("section");
    expect(page).toBeTruthy();
    const mapping = within(page!);
    await waitFor(() =>
      expect(mapping.getByRole("button", { name: "Connect" })).toBeDisabled()
    );
    await user.click(
      mapping.getByRole("radio", {
        name: /Make the existing trunk branch the default/
      })
    );
    await user.click(mapping.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(body?.default_branch_mapping).toEqual({
        mode: "use_existing",
        branch_id: trunk.id
      })
    );
  });

  it("shows a candidates error with plain language", async () => {
    await render(
      `/projects/${projectId}/connect?repository_authorization=${authorizationId}`,
      connectHandlers({
        extra: [
          http.get(
            `${apiUrl}/projects/:projectId/repository/authorizations/:authorizationId/repositories`,
            () =>
              HttpResponse.json(
                {
                  error: {
                    code: "REPOSITORY_AUTHORIZATION_INVALID",
                    message: "gone",
                    details: {},
                    request_id: "req_test"
                  }
                },
                { status: 409 }
              )
          )
        ]
      })
    );
    expect(
      await screen.findByText(
        "This authorization expired or was already used. Start again."
      )
    ).toBeVisible();
  });
});
