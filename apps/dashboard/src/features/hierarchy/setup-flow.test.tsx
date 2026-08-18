import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { AuthClient, AuthSnapshot } from "@/features/auth/auth-client";
import { hierarchyKeys } from "./query-options";
import { organization, project, workspace } from "@/test/factories";
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

const authorized = (request: Request) =>
  expect(request.headers.get("authorization")).toBe("Bearer test-token");
const emptyHierarchy = () => [
  http.get(`${apiUrl}/organizations`, ({ request }) => {
    authorized(request);
    return HttpResponse.json({ organizations: [] });
  })
];

function renderSetup(handlers = emptyHierarchy()) {
  return renderDashboardRoute({
    path: "/setup",
    auth: new FakeAuthClient(),
    platform,
    handlers
  });
}

describe("SetupFlow", () => {
  it("shows organization creation when there are no accessible organizations", async () => {
    await renderSetup();
    expect(
      await screen.findByRole("heading", { name: "Create your organization" })
    ).toHaveFocus();
    expect(screen.getByLabelText("Organization name")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Create organization" })
    ).toBeEnabled();
  });

  it("invalidates organizations and advances to workspace creation after an organization is created", async () => {
    const created = organization({ name: "Acme" });
    let organizations = [] as (typeof created)[];
    const view = await renderSetup([
      http.get(`${apiUrl}/organizations`, () =>
        HttpResponse.json({ organizations })
      ),
      http.post(`${apiUrl}/organizations`, async ({ request }) => {
        authorized(request);
        expect(await request.json()).toEqual({ name: "Acme" });
        organizations = [created];
        return HttpResponse.json(created, { status: 201 });
      }),
      http.get(
        `${apiUrl}/organizations/:organizationId/workspaces`,
        ({ params }) => {
          expect(params.organizationId).toBe(created.id);
          return HttpResponse.json({ workspaces: [] });
        }
      )
    ]);
    const invalidate = vi.spyOn(view.queryClient, "invalidateQueries");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Organization name"), "Acme");
    await user.click(
      screen.getByRole("button", { name: "Create organization" })
    );
    expect(await screen.findByLabelText("Workspace name")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Create your workspace" })
    ).toHaveFocus();
    expect(screen.getByText("Organization: Acme")).toBeVisible();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: hierarchyKeys.organizations()
    });
  });

  it("shows workspace creation with the selected organization context", async () => {
    const parent = organization({ name: "Acme" });
    await renderSetup([
      http.get(`${apiUrl}/organizations`, () =>
        HttpResponse.json({ organizations: [parent] })
      ),
      http.get(`${apiUrl}/organizations/:organizationId/workspaces`, () =>
        HttpResponse.json({ workspaces: [] })
      )
    ]);
    expect(await screen.findByLabelText("Workspace name")).toBeVisible();
    expect(screen.getByText("Organization: Acme")).toBeVisible();
  });

  it("shows project creation with the selected workspace context", async () => {
    const parent = organization({ name: "Acme" });
    const child = workspace({ name: "Platform", organization_id: parent.id });
    await renderSetup([
      http.get(`${apiUrl}/organizations`, () =>
        HttpResponse.json({ organizations: [parent] })
      ),
      http.get(`${apiUrl}/organizations/:organizationId/workspaces`, () =>
        HttpResponse.json({ workspaces: [child] })
      ),
      http.get(`${apiUrl}/workspaces/:workspaceId/projects`, () =>
        HttpResponse.json({ projects: [] })
      )
    ]);
    expect(await screen.findByLabelText("Project name")).toBeVisible();
    expect(screen.getByLabelText("Description (optional)")).toBeVisible();
    expect(screen.getByText("Workspace: Platform")).toBeVisible();
  });

  it("navigates to the created project overview", async () => {
    const parent = organization();
    const child = workspace();
    const created = project({ name: "Dashboard", workspace_id: child.id });
    const view = await renderSetup([
      http.get(`${apiUrl}/organizations`, () =>
        HttpResponse.json({ organizations: [parent] })
      ),
      http.get(`${apiUrl}/organizations/:organizationId/workspaces`, () =>
        HttpResponse.json({ workspaces: [child] })
      ),
      http.get(`${apiUrl}/workspaces/:workspaceId/projects`, () =>
        HttpResponse.json({ projects: [] })
      ),
      http.post(
        `${apiUrl}/workspaces/:workspaceId/projects`,
        async ({ request }) => {
          authorized(request);
          expect(await request.json()).toEqual({
            name: "Dashboard",
            description: "A real project"
          });
          return HttpResponse.json(created, { status: 201 });
        }
      )
    ]);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Project name"), "Dashboard");
    await user.type(
      screen.getByLabelText("Description (optional)"),
      "A real project"
    );
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/projects/${created.id}/overview`
      )
    );
  });

  it("associates a server validation alert with the name field and permits a retry", async () => {
    const created = organization({ name: "Acme" });
    let attempts = 0;
    await renderSetup([
      ...emptyHierarchy(),
      http.post(`${apiUrl}/organizations`, () => {
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json(
              {
                error: {
                  code: "VALIDATION_ERROR",
                  message: "The request is invalid",
                  details: {},
                  request_id: "req_validation"
                }
              },
              { status: 422 }
            )
          : HttpResponse.json(created, { status: 201 });
      }),
      http.get(`${apiUrl}/organizations/:organizationId/workspaces`, () =>
        HttpResponse.json({ workspaces: [] })
      )
    ]);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Organization name"), "Acme");
    await user.click(
      screen.getByRole("button", { name: "Create organization" })
    );
    const alert = await screen.findByRole("alert");
    const name = screen.getByLabelText("Organization name");
    expect(alert).toHaveTextContent("The request is invalid");
    expect(alert).toHaveAttribute("id", "organization-name-error");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAttribute("aria-describedby", "organization-name-error");
    expect(screen.getByText("Reference req_validation")).toBeInTheDocument();
    expect(
      screen.queryByText("validation details", { exact: false })
    ).not.toBeInTheDocument();
    expect(name).toHaveValue("Acme");
    await user.click(
      screen.getByRole("button", { name: "Create organization" })
    );
    expect(await screen.findByLabelText("Workspace name")).toBeVisible();
    expect(attempts).toBe(2);
  });

  it("redirects to an existing project without rendering a create form", async () => {
    const parent = organization();
    const child = workspace();
    const existing = project();
    const view = await renderSetup([
      http.get(`${apiUrl}/organizations`, () =>
        HttpResponse.json({ organizations: [parent] })
      ),
      http.get(`${apiUrl}/organizations/:organizationId/workspaces`, () =>
        HttpResponse.json({ workspaces: [child] })
      ),
      http.get(`${apiUrl}/workspaces/:workspaceId/projects`, () =>
        HttpResponse.json({ projects: [existing] })
      )
    ]);
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/projects/${existing.id}/overview`
      )
    );
    expect(
      screen.queryByRole("button", {
        name: /create (organization|workspace|project)/i
      })
    ).not.toBeInTheDocument();
  });

  it("blocks synchronous repeated submit events before pending state rerenders", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const post = vi.fn(async () => {
      await pending;
      return HttpResponse.json(organization(), { status: 201 });
    });
    await renderSetup([
      ...emptyHierarchy(),
      http.post(`${apiUrl}/organizations`, post)
    ]);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Organization name"), "Acme");
    const form = screen
      .getByRole("button", { name: "Create organization" })
      .closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    fireEvent.submit(form!);
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    resolve();
  });

  it("associates client schema validation with the project description field", async () => {
    const parent = organization({ name: "Acme" });
    const child = workspace({ name: "Platform", organization_id: parent.id });
    const post = vi.fn();
    await renderSetup([
      http.get(`${apiUrl}/organizations`, () =>
        HttpResponse.json({ organizations: [parent] })
      ),
      http.get(`${apiUrl}/organizations/:organizationId/workspaces`, () =>
        HttpResponse.json({ workspaces: [child] })
      ),
      http.get(`${apiUrl}/workspaces/:workspaceId/projects`, () =>
        HttpResponse.json({ projects: [] })
      ),
      http.post(`${apiUrl}/workspaces/:workspaceId/projects`, post)
    ]);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Project name"), "Dashboard");
    const description = screen.getByLabelText("Description (optional)");
    fireEvent.change(description, { target: { value: "x".repeat(4001) } });
    await user.click(screen.getByRole("button", { name: "Create project" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("id", "project-description-error");
    expect(description).toHaveAttribute("aria-invalid", "true");
    expect(description).toHaveAttribute(
      "aria-describedby",
      "project-description-error"
    );
    expect(screen.getByLabelText("Project name")).not.toHaveAttribute(
      "aria-describedby"
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("retries a hierarchy query without rendering its failure details", async () => {
    let fail = true;
    let requests = 0;
    await renderSetup([
      http.get(`${apiUrl}/organizations`, () => {
        requests += 1;
        if (fail)
          return HttpResponse.json(
            {
              error: {
                code: "INTERNAL_ERROR",
                message: "private query failure details",
                details: { query: "do-not-render" },
                request_id: "req_query"
              }
            },
            { status: 500 }
          );
        return HttpResponse.json({ organizations: [] });
      })
    ]);
    const user = userEvent.setup();
    expect(
      await screen.findByRole("heading", {
        name: "We couldn’t load your setup"
      })
    ).toBeVisible();
    expect(
      screen.queryByText("private query failure details")
    ).not.toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "Create your organization" })
    ).toBeVisible();
    expect(requests).toBe(2);
  });

  it("selects organization and workspace pickers with the keyboard", async () => {
    const acme = organization({
      id: "00000000-0000-4000-8000-000000000011",
      name: "Acme"
    });
    const globex = organization({
      id: "00000000-0000-4000-8000-000000000012",
      name: "Globex"
    });
    const platform = workspace({
      id: "00000000-0000-4000-8000-000000000021",
      name: "Platform",
      organization_id: acme.id
    });
    const operations = workspace({
      id: "00000000-0000-4000-8000-000000000022",
      name: "Operations",
      organization_id: acme.id
    });
    const other = workspace({
      id: "00000000-0000-4000-8000-000000000023",
      name: "Other",
      organization_id: globex.id
    });
    await renderSetup([
      http.get(`${apiUrl}/organizations`, () =>
        HttpResponse.json({ organizations: [acme, globex] })
      ),
      http.get(
        `${apiUrl}/organizations/:organizationId/workspaces`,
        ({ params }) =>
          HttpResponse.json({
            workspaces:
              params.organizationId === globex.id
                ? [other]
                : [platform, operations]
          })
      ),
      http.get(`${apiUrl}/workspaces/:workspaceId/projects`, () =>
        HttpResponse.json({ projects: [] })
      )
    ]);
    const user = userEvent.setup();
    expect(await screen.findByText("Workspace: Platform")).toBeVisible();
    screen.getByRole("button", { name: "Select workspace" }).focus();
    await user.keyboard("{Enter}{ArrowDown}{Enter}");
    expect(await screen.findByText("Workspace: Operations")).toBeVisible();
    screen.getByRole("button", { name: "Select organization" }).focus();
    await user.keyboard("{Enter}{ArrowDown}{Enter}");
    expect(await screen.findByText("Organization: Globex")).toBeVisible();
    expect(await screen.findByText("Workspace: Other")).toBeVisible();
  });
});
