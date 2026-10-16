import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, type RequestHandler } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Branch,
  RepositoryConnection,
  RepositoryConnectionStatus
} from "@orchestrat/protocol";
import { branch, project, taskCard } from "@/test/factories";
import {
  apiUrl,
  branchHandlers,
  main,
  projectId,
  render
} from "@/test/branch-routes";
import { REPOSITORY_ATTEMPT_KEY } from "@/features/repository/repository-copy";

// Settings › Repository and the GitHub Setup URL.

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

function settings({
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

afterEach(() => {
  goTo.mockReset();
  window.sessionStorage.clear();
});

describe("repository settings", () => {
  it("starts a connection with the provider and shows unconfigured ones", async () => {
    let body: unknown;
    await render(
      `/projects/${projectId}/settings`,
      settings({
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
    const gitlab = await screen.findByRole("button", {
      name: "Connect GitLab.com"
    });
    expect(gitlab).toBeDisabled();
    expect(gitlab).toHaveAccessibleDescription(
      "GitLab isn’t set up on this server."
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Connect GitHub" }));
    await waitFor(() =>
      expect(goTo).toHaveBeenCalledWith(
        "https://github.com/login/oauth/authorize?x=1"
      )
    );
    expect(body).toEqual({
      provider: "github",
      return_path: `/projects/${projectId}/settings`
    });
    expect(
      JSON.parse(window.sessionStorage.getItem(REPOSITORY_ATTEMPT_KEY)!)
    ).toEqual({
      authorization_id: authorizationId,
      project_id: projectId,
      provider: "github"
    });
  });

  it("shows members the status without connection actions", async () => {
    await render(
      `/projects/${projectId}/settings`,
      settings({ role: "member" })
    );
    expect(
      await screen.findByText(
        "No repository is connected. Owners and admins can connect one."
      )
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Connect / })
    ).not.toBeInTheDocument();
  });

  it("explains a failed provider redirect", async () => {
    await render(
      `/projects/${projectId}/settings?repository_error=expired`,
      settings()
    );
    expect(
      await screen.findByText(
        "Connecting took too long and the link expired. Start again."
      )
    ).toBeVisible();
  });

  it("picks a repository, renames the default and connects", async () => {
    let body: unknown;
    let connected: RepositoryConnection | null = null;
    const view = await render(
      `/projects/${projectId}/settings?repository_authorization=${authorizationId}`,
      settings({
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
    const dialog = await screen.findByRole("dialog", {
      name: "Choose a repository"
    });
    const mirror = await within(dialog).findByRole("radio", {
      name: /acme\/mirror/
    });
    expect(mirror).toBeDisabled();
    expect(dialog).toHaveTextContent("GitHub mirrors can’t be connected.");
    const user = userEvent.setup();
    expect(within(dialog).getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(within(dialog).getByRole("radio", { name: /acme\/app/ }));
    await user.click(within(dialog).getByRole("button", { name: "Next" }));
    const mapping = await screen.findByRole("dialog", {
      name: "Default branch"
    });
    expect(mapping).toHaveTextContent(
      "Your default branch main will be renamed to trunk and track it. All existing work stays."
    );
    await user.click(
      within(mapping).getByRole("checkbox", {
        name: /Also create Orchestrat branches/
      })
    );
    await user.click(within(mapping).getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Default branch" })
      ).not.toBeInTheDocument()
    );
    expect(body).toEqual({
      authorization_id: authorizationId,
      provider_repository_id: "101",
      default_branch_mapping: { mode: "rename_default" },
      create_existing_branches: true
    });
    expect(view.router.state.location.search).toEqual({});
    expect(await screen.findByRole("link", { name: "acme/app" })).toBeVisible();
  });

  it("links a default that already matches", async () => {
    await render(
      `/projects/${projectId}/settings?repository_authorization=${authorizationId}`,
      settings({ extra: [candidates("main")] })
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /acme\/app/ }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/Nothing is renamed\./)).toHaveTextContent(
      "Your default branch main will track acme/app’s main. Nothing is renamed."
    );
  });

  it("asks which branch wins when one already has the provider's name", async () => {
    for (const empty of [false, true]) {
      let body: Record<string, unknown> | undefined;
      const view = await render(
        `/projects/${projectId}/settings?repository_authorization=${authorizationId}`,
        settings({
          branches: [main, trunk],
          extra: [
            candidates("trunk"),
            http.get(`${apiUrl}/projects/:projectId/tasks`, ({ request }) =>
              new URL(request.url).searchParams.get("branch_id") === trunk.id &&
              !empty
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
      const mapping = await screen.findByRole("dialog", {
        name: "Default branch"
      });
      const keep = within(mapping).getByRole("radio", {
        name: /Keep main’s work as trunk/
      });
      const switchDefault = within(mapping).getByRole("radio", {
        name: /Make the existing trunk branch the default/
      });
      if (empty) {
        // An empty namesake makes keeping the default's work the advice.
        await waitFor(() => expect(keep).toBeChecked());
        expect(mapping).toHaveTextContent("Recommended: it’s empty.");
      } else {
        await waitFor(() =>
          expect(
            within(mapping).getByRole("button", { name: "Connect" })
          ).toBeDisabled()
        );
        expect(keep).not.toBeChecked();
        await user.click(switchDefault);
      }
      await user.click(
        within(mapping).getByRole("button", { name: "Connect" })
      );
      await waitFor(() =>
        expect(body?.default_branch_mapping).toEqual(
          empty
            ? { mode: "rename_default" }
            : { mode: "use_existing", branch_id: trunk.id }
        )
      );
      view.unmount();
    }
  });

  it("shows each connection status", async () => {
    const cases: [RepositoryConnectionStatus, string, string | null][] = [
      ["active", "Active", null],
      [
        "needs_reauthorization",
        "Needs reauthorization",
        "The GitLab grant was revoked."
      ],
      ["suspended", "Suspended", "The GitHub App installation is suspended."],
      ["error", "Error", "The last sync failed: rate limited."]
    ];
    for (const [status, label, reason] of cases) {
      const view = await render(
        `/projects/${projectId}/settings`,
        settings({
          repository: connection({ status, status_reason: reason })
        })
      );
      const card = (
        await screen.findByRole("heading", { name: "Repository" })
      ).closest("[data-slot='card']") as HTMLElement;
      await within(card).findByText(label);
      if (reason) expect(card).toHaveTextContent(reason);
      view.unmount();
    }
  });

  it("syncs, re-enables a paused hook, retries deliveries and disconnects", async () => {
    const calls: string[] = [];
    const record =
      (name: string, response: () => Response) =>
      ({ request }: { request: Request }) => {
        calls.push(`${request.method} ${name}`);
        return response();
      };
    await render(
      `/projects/${projectId}/settings`,
      settings({
        repository: connection({
          provider: "gitlab",
          full_name: "acme/app",
          url: "https://gitlab.com/acme/app",
          failed_delivery_count: 1,
          hook_health: {
            alert_status: "temporarily_disabled",
            disabled_until: "2026-10-01T01:00:00.000Z"
          }
        }),
        extra: [
          http.post(
            `${apiUrl}/projects/:projectId/repository/sync`,
            record("sync", () =>
              HttpResponse.json({ queued: true }, { status: 202 })
            )
          ),
          http.post(
            `${apiUrl}/projects/:projectId/repository/hook/reenable`,
            record("reenable", () =>
              HttpResponse.json({ queued: true }, { status: 202 })
            )
          ),
          http.get(`${apiUrl}/projects/:projectId/repository/deliveries`, () =>
            HttpResponse.json({
              deliveries: [
                {
                  id: "00000000-0000-4000-8000-000000000601",
                  provider: "gitlab",
                  event_type: "Push Hook",
                  status: "failed",
                  attempts: 10,
                  last_error: "Timed out",
                  received_at: "2026-09-30T07:00:00.000Z",
                  processed_at: null
                }
              ]
            })
          ),
          http.post(
            `${apiUrl}/projects/:projectId/repository/deliveries/:deliveryId/retry`,
            record("retry", () =>
              HttpResponse.json({
                delivery: {
                  id: "00000000-0000-4000-8000-000000000601",
                  provider: "gitlab",
                  event_type: "Push Hook",
                  status: "pending",
                  attempts: 0,
                  last_error: null,
                  received_at: "2026-09-30T07:00:00.000Z",
                  processed_at: null
                }
              })
            )
          ),
          http.delete(
            `${apiUrl}/projects/:projectId/repository`,
            record("repository", () => new HttpResponse(null, { status: 204 }))
          )
        ]
      })
    );
    const user = userEvent.setup();
    expect(
      await screen.findByText(
        /GitLab paused the webhook after failed deliveries/
      )
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Re-enable" }));
    expect(
      await screen.findByText(
        "GitLab sent a test delivery to wake the webhook."
      )
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Sync now" }));
    expect(
      await screen.findByText("Sync requested. Branches update shortly.")
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Failed deliveries (1)" })
    );
    expect(await screen.findByText("Push Hook")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    const confirm = await screen.findByRole("dialog", {
      name: "Disconnect acme/app?"
    });
    expect(confirm).toHaveTextContent("Branches and their work are kept.");
    await user.click(
      within(confirm).getByRole("button", { name: "Disconnect" })
    );
    await waitFor(() =>
      expect(calls).toEqual([
        "POST reenable",
        "POST sync",
        "POST retry",
        "DELETE repository"
      ])
    );
  });

  it("shows a failed disconnect inside its dialog", async () => {
    await render(
      `/projects/${projectId}/settings`,
      settings({
        repository: connection(),
        extra: [
          http.delete(`${apiUrl}/projects/:projectId/repository`, () =>
            HttpResponse.json(
              {
                error: {
                  code: "INTERNAL_ERROR",
                  message: "The provider didn't answer. Try again.",
                  request_id: "req_1",
                  details: {}
                }
              },
              { status: 502 }
            )
          )
        ]
      })
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    const confirm = await screen.findByRole("dialog", {
      name: "Disconnect acme/app?"
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Disconnect" })
    );
    expect(await within(confirm).findByRole("alert")).toHaveTextContent(
      "The provider didn't answer. Try again."
    );
  });

  it("reconnects by disconnecting and authorizing again", async () => {
    let current: RepositoryConnection | null = connection({
      status: "needs_reauthorization",
      status_reason: "The grant was revoked."
    });
    await render(
      `/projects/${projectId}/settings`,
      settings({
        repository: () => current,
        extra: [
          http.delete(`${apiUrl}/projects/:projectId/repository`, () => {
            current = null;
            return new HttpResponse(null, { status: 204 });
          }),
          http.post(
            `${apiUrl}/projects/:projectId/repository/authorizations`,
            () =>
              HttpResponse.json({
                authorization_id: authorizationId,
                authorize_url: "https://github.com/login/oauth/authorize?y=2",
                expires_at: "2026-09-30T10:00:00.000Z"
              })
          )
        ]
      })
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reconnect" }));
    const confirm = await screen.findByRole("dialog", {
      name: "Reconnect acme/app?"
    });
    expect(confirm).toHaveTextContent("Branches and their work are kept.");
    await user.click(
      within(confirm).getByRole("button", { name: "Reconnect" })
    );
    await waitFor(() =>
      expect(goTo).toHaveBeenCalledWith(
        "https://github.com/login/oauth/authorize?y=2"
      )
    );
  });
});

describe("GitHub Setup URL", () => {
  const attempt = () =>
    window.sessionStorage.setItem(
      REPOSITORY_ATTEMPT_KEY,
      JSON.stringify({
        authorization_id: authorizationId,
        project_id: projectId,
        provider: "github"
      })
    );

  it("checks the installation and opens the picker", async () => {
    attempt();
    let body: unknown;
    const view = await render("/repository/github/setup?installation_id=4242", [
      http.post(
        `${apiUrl}/projects/:projectId/repository/authorizations/:authorizationId/github-installation`,
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ next: "pick_repository" });
        }
      ),
      candidates("main"),
      ...settings()
    ]);
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/projects/${projectId}/settings`
      )
    );
    expect(view.router.state.location.search).toEqual({
      repository_authorization: authorizationId
    });
    expect(body).toEqual({ installation_id: "4242" });
    expect(
      await screen.findByRole("dialog", { name: "Choose a repository" })
    ).toBeVisible();
  });

  it("sends the person to authorize when GitHub needs a fresh grant", async () => {
    attempt();
    await render("/repository/github/setup?installation_id=4242", [
      http.post(
        `${apiUrl}/projects/:projectId/repository/authorizations/:authorizationId/github-installation`,
        () =>
          HttpResponse.json({
            next: "authorize",
            authorize_url: "https://github.com/login/oauth/authorize?z=3"
          })
      ),
      ...settings()
    ]);
    await waitFor(() =>
      expect(goTo).toHaveBeenCalledWith(
        "https://github.com/login/oauth/authorize?z=3"
      )
    );
  });
});
