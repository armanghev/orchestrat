import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { organization, project, workspace } from "@/test/factories";
import type { AuthClient, AuthSnapshot } from "@/features/auth/auth-client";
import type { Platform } from "@/platform/contract";
import { renderDashboardRoute } from "@/test/render";

class FakeAuthClient implements AuthClient {
  private snapshot: AuthSnapshot;
  private listeners = new Set<() => void>();
  completeSignIn = vi.fn(async (callbackUrl: string) => { void callbackUrl; this.setSnapshot({ status: "signedIn" }); });

  constructor(snapshot: AuthSnapshot) { this.snapshot = snapshot; }
  async initialize() {}
  getSnapshot() { return this.snapshot; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async signIn() { this.setSnapshot({ status: "signingIn" }); }
  async signOut() { this.setSnapshot({ status: "signedOut" }); }
  async expireSession() { this.setSnapshot({ status: "signedOut" }); }
  async getAccessToken() { return this.snapshot.status === "signedIn" ? "test-token" : null; }
  setSnapshot(snapshot: AuthSnapshot) { this.snapshot = snapshot; this.listeners.forEach((listener) => listener()); }
}

function platform(): Platform {
  return {
    kind: "web",
    preferences: { load: vi.fn(async () => null), save: vi.fn(async () => undefined) },
    openExternal: vi.fn(async () => undefined),
    onAuthCallback: vi.fn(async () => () => undefined)
  };
}

describe("dashboard routes", () => {
  it("shows browser sign-in at the signed-out root", async () => {
    await renderDashboardRoute({ path: "/", auth: new FakeAuthClient({ status: "signedOut" }), platform: platform() });
    expect(await screen.findByRole("button", { name: "Continue in browser" })).toBeVisible();
  });

  it("keeps protected content hidden while session restoration is loading", async () => {
    await renderDashboardRoute({ path: "/setup", auth: new FakeAuthClient({ status: "loading" }), platform: platform() });
    expect(await screen.findByRole("status", { name: "Restoring session…" })).toBeVisible();
    expect(screen.queryByText(/setup/i)).not.toBeInTheDocument();
  });

  it("redirects signed-out setup navigation to the root", async () => {
    const view = await renderDashboardRoute({ path: "/setup", auth: new FakeAuthClient({ status: "signedOut" }), platform: platform() });
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/"));
    expect(screen.getByRole("button", { name: "Continue in browser" })).toBeVisible();
  });

  it("redirects a successfully completed browser callback to setup without exposing its query or mutating the browser URL", async () => {
    const auth = new FakeAuthClient({ status: "signedOut" });
    const browserPathBeforeRender = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const view = await renderDashboardRoute({ path: "/auth/callback?code=a&state=b", auth, platform: platform() });

    await waitFor(() => expect(auth.completeSignIn).toHaveBeenCalledOnce());
    const callbackUrl = new URL(auth.completeSignIn.mock.calls[0]?.[0] ?? "");
    expect(callbackUrl.origin).toBe(window.location.origin);
    expect(callbackUrl.pathname).toBe("/auth/callback");
    expect(callbackUrl.search).toBe("?code=a&state=b");
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/setup"));
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(browserPathBeforeRender);
    expect(document.body.textContent).not.toContain("code=a");
    expect(document.body.textContent).not.toContain("state=b");
  });

  it("renders safe recovery after callback completion rejects and returns to sign-in on retry", async () => {
    const auth = new FakeAuthClient({ status: "signingIn" });
    auth.completeSignIn.mockRejectedValue(new Error("code=secret-token"));
    const view = await renderDashboardRoute({ path: "/auth/callback?code=secret-token&state=opaque", auth, platform: platform() });

    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't complete your sign-in.");
    expect(document.body.textContent).not.toContain("secret-token");
    expect(document.body.textContent).not.toContain("opaque");

    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/"));
    expect(await screen.findByRole("button", { name: "Continue in browser" })).toBeVisible();
  });

  it("does not change the browser URL across back-to-back route renders", async () => {
    const browserPathBeforeRender = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const first = await renderDashboardRoute({ path: "/", auth: new FakeAuthClient({ status: "signedOut" }), platform: platform() });
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(browserPathBeforeRender);
    first.unmount();

    const second = await renderDashboardRoute({ path: "/setup", auth: new FakeAuthClient({ status: "signedIn" }), platform: platform() });
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(browserPathBeforeRender);
    second.unmount();
  });

  it("sends an authenticated user with an existing project through setup to its overview", async () => {
    const view = await renderDashboardRoute({ path: "/setup", auth: new FakeAuthClient({ status: "signedIn" }), platform: platform() });
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/projects/00000000-0000-4000-8000-000000000003/overview"));
    expect(screen.queryByRole("button", { name: /create (organization|workspace|project)/i })).not.toBeInTheDocument();
  });

  const projectId = "11111111-1111-4111-8111-111111111111";
  const missingProjectId = "99999999-9999-4999-8999-999999999999";
  const catalogHandlers = (options: { projects?: ReturnType<typeof project>[]; partialFailure?: boolean } = {}) => {
    const organizationRecord = organization({ name: "Northstar Organization", role: "admin" });
    const workspaceRecord = workspace({ name: "Product Workspace", organization_id: organizationRecord.id });
    const projects = options.projects ?? [project({ id: projectId, workspace_id: workspaceRecord.id, name: "Native Dashboard", slug: "native-dashboard", description: "The dashboard used by the platform team.", status: "active" })];
    return [
      http.get("http://localhost:3001/api/v1/organizations", () => HttpResponse.json({ organizations: [organizationRecord] })),
      http.get("http://localhost:3001/api/v1/organizations/:organizationId/workspaces", () => HttpResponse.json({ workspaces: [workspaceRecord] })),
      http.get("http://localhost:3001/api/v1/workspaces/:workspaceId/projects", () => options.partialFailure ? HttpResponse.error() : HttpResponse.json({ projects }))
    ];
  };

  it("renders the overview from the matching catalog project without operational metrics", async () => {
    await renderDashboardRoute({ path: `/projects/${projectId}/overview`, auth: new FakeAuthClient({ status: "signedIn" }), platform: platform(), handlers: catalogHandlers() });
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeVisible();
    expect(screen.getByText("Northstar Organization")).toBeVisible();
    expect(screen.getByText("Product Workspace")).toBeVisible();
    expect(screen.getByText("Native Dashboard")).toBeVisible();
    expect(screen.getByText("native-dashboard")).toBeVisible();
    expect(screen.getByText("active")).toBeVisible();
    expect(screen.getByText("admin")).toBeVisible();
    expect(screen.getByText("The dashboard used by the platform team.")).toBeVisible();
    expect(screen.queryByText(/active agents|open tasks/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+$/)).not.toBeInTheDocument();
  });

  it.each([
    ["tasks", "Tasks", "Task service unavailable"],
    ["agents", "Agents", "Agent service unavailable"],
    ["documents", "Documents", "Document service unavailable"],
    ["messages", "Messages", "Messaging service unavailable"],
    ["activity", "Activity", "Activity service unavailable"],
    ["integrations", "Integrations", "Integration service unavailable"]
  ])("renders an honest unavailable state for %s", async (route, heading, status) => {
    await renderDashboardRoute({ path: `/projects/${projectId}/${route}`, auth: new FakeAuthClient({ status: "signedIn" }), platform: platform(), handlers: catalogHandlers() });
    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
    expect(screen.getByText(status)).toBeVisible();
    expect(screen.getByRole("link", { name: "Return to overview" })).toHaveAttribute("href", `/projects/${projectId}/overview`);
  });

  it("does not silently switch projects when catalog access to the URL project is unavailable", async () => {
    await renderDashboardRoute({ path: `/projects/${missingProjectId}/overview`, auth: new FakeAuthClient({ status: "signedIn" }), platform: platform(), handlers: catalogHandlers() });
    const heading = await screen.findByRole("heading", { name: "Project access unavailable" });
    expect(heading).toHaveFocus();
    expect(screen.queryByText("Native Dashboard")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Project switcher/i })).toBeVisible();
    expect(screen.getByRole("link", { name: /Setup/i })).toBeVisible();
  });

  it("redirects an empty catalog to setup", async () => {
    const view = await renderDashboardRoute({ path: `/projects/${projectId}/overview`, auth: new FakeAuthClient({ status: "signedIn" }), platform: platform(), handlers: [http.get("http://localhost:3001/api/v1/organizations", () => HttpResponse.json({ organizations: [] }))] });
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/setup"));
  });

  it("keeps a known project visible with a retry warning after a partial catalog failure", async () => {
    const organizationRecord = organization();
    const knownWorkspace = workspace({ id: "22222222-2222-4222-8222-222222222222", organization_id: organizationRecord.id });
    const failedWorkspace = workspace({ id: "33333333-3333-4333-8333-333333333333", organization_id: organizationRecord.id, name: "Unreachable workspace" });
    const knownProject = project({ id: projectId, workspace_id: knownWorkspace.id });
    await renderDashboardRoute({ path: `/projects/${projectId}/overview`, auth: new FakeAuthClient({ status: "signedIn" }), platform: platform(), handlers: [
      http.get("http://localhost:3001/api/v1/organizations", () => HttpResponse.json({ organizations: [organizationRecord] })),
      http.get("http://localhost:3001/api/v1/organizations/:organizationId/workspaces", () => HttpResponse.json({ workspaces: [knownWorkspace, failedWorkspace] })),
      http.get(`http://localhost:3001/api/v1/workspaces/${knownWorkspace.id}/projects`, () => HttpResponse.json({ projects: [knownProject] })),
      http.get(`http://localhost:3001/api/v1/workspaces/${failedWorkspace.id}/projects`, () => HttpResponse.error())
    ] });
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Some projects could not be loaded.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("redirects a project index to Overview", async () => {
    const view = await renderDashboardRoute({ path: `/projects/${projectId}`, auth: new FakeAuthClient({ status: "signedIn" }), platform: platform(), handlers: catalogHandlers() });
    await waitFor(() => expect(view.router.state.location.pathname).toBe(`/projects/${projectId}/overview`));
  });

  it("limits preferences to appearance and contextual-sidebar changes", async () => {
    await renderDashboardRoute({ path: "/preferences", auth: new FakeAuthClient({ status: "signedIn" }), platform: platform(), handlers: catalogHandlers() });
    expect(await screen.findByRole("heading", { name: "Preferences" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "System" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Light" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Dark" })).toBeVisible();
    expect(screen.getByRole("switch", { name: /Contextual sidebar/i })).toBeVisible();
    expect(screen.getByText(/rail customization is not exposed/i)).toBeVisible();
    expect(screen.queryByText(/OAuth|updater|notification/i)).not.toBeInTheDocument();
  });

  it("shows only real project metadata in Project Settings", async () => {
    await renderDashboardRoute({ path: `/projects/${projectId}/settings`, auth: new FakeAuthClient({ status: "signedIn" }), platform: platform(), handlers: catalogHandlers() });
    expect(await screen.findByRole("heading", { name: "Project Settings" })).toBeVisible();
    expect(screen.getAllByText("Native Dashboard").at(-1)).toBeVisible();
    expect(screen.getAllByText("native-dashboard").at(-1)).toBeVisible();
    expect(screen.getByRole("link", { name: /Preferences/i })).toHaveAttribute("href", "/preferences");
    expect(screen.queryByRole("button", { name: /archive|update/i })).not.toBeInTheDocument();
  });

  it("focuses the main heading after a main navigation route change", async () => {
    const view = await renderDashboardRoute({ path: `/projects/${projectId}/overview`, auth: new FakeAuthClient({ status: "signedIn" }), platform: platform(), handlers: catalogHandlers() });
    await screen.findByRole("heading", { name: "Overview" });
    await act(async () => {
      await view.router.navigate({ to: "/projects/$projectId/tasks", params: { projectId } });
    });
    const heading = await screen.findByRole("heading", { name: "Tasks" });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("retries a route loader error after the hierarchy handler recovers", async () => {
    let fail = true;
    const recoveredOrganization = organization();
    const recoveredWorkspace = workspace({ organization_id: recoveredOrganization.id });
    const recoveredProject = project({ id: projectId, workspace_id: recoveredWorkspace.id });
    const view = await renderDashboardRoute({ path: `/projects/${projectId}/overview`, auth: new FakeAuthClient({ status: "signedIn" }), platform: platform(), handlers: [
      http.get("http://localhost:3001/api/v1/organizations", () => fail
        ? HttpResponse.error()
        : HttpResponse.json({ organizations: [recoveredOrganization] })),
      http.get("http://localhost:3001/api/v1/organizations/:organizationId/workspaces", () => HttpResponse.json({ workspaces: [recoveredWorkspace] })),
      http.get("http://localhost:3001/api/v1/workspaces/:workspaceId/projects", () => HttpResponse.json({ projects: [recoveredProject] }))
    ] });

    const unavailable = await screen.findByRole("heading", { name: "Project unavailable" });
    expect(unavailable).toHaveFocus();
    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeVisible();
    expect(view.router.state.location.pathname).toBe(`/projects/${projectId}/overview`);
  });

  it("does not redirect an all-child-failure catalog to setup", async () => {
    const organizationRecord = organization();
    const workspaceRecord = workspace({ organization_id: organizationRecord.id });
    const recoveredProject = project({ id: projectId, workspace_id: workspaceRecord.id });
    let fail = true;
    const view = await renderDashboardRoute({ path: `/projects/${projectId}/overview`, auth: new FakeAuthClient({ status: "signedIn" }), platform: platform(), handlers: [
      http.get("http://localhost:3001/api/v1/organizations", () => HttpResponse.json({ organizations: [organizationRecord] })),
      http.get("http://localhost:3001/api/v1/organizations/:organizationId/workspaces", () => HttpResponse.json({ workspaces: [workspaceRecord] })),
      http.get("http://localhost:3001/api/v1/workspaces/:workspaceId/projects", () => fail ? HttpResponse.error() : HttpResponse.json({ projects: [recoveredProject] }))
    ] });

    const unavailable = await screen.findByRole("heading", { name: "Project catalog unavailable" });
    expect(unavailable).toHaveFocus();
    expect(view.router.state.location.pathname).toBe(`/projects/${projectId}/overview`);
    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeVisible();
  });

  it("focuses the Preferences heading after its route loads", async () => {
    await renderDashboardRoute({ path: "/preferences", auth: new FakeAuthClient({ status: "signedIn" }), platform: platform(), handlers: catalogHandlers() });
    expect(await screen.findByRole("heading", { name: "Preferences" })).toHaveFocus();
  });

  it("makes keyboard-focused theme radios visibly indicated", async () => {
    await renderDashboardRoute({ path: "/preferences", auth: new FakeAuthClient({ status: "signedIn" }), platform: platform(), handlers: catalogHandlers() });
    const system = await screen.findByRole("radio", { name: "System" });
    await userEvent.setup().tab();
    expect(system).toHaveFocus();
    expect(system.closest("label")).toHaveClass("has-[:focus-visible]:ring-2");
  });

  it("shows the safe application error view for a render error", async () => {
    const { createRootRouteWithContext, createRoute, createRouter, RouterProvider } = await import("@tanstack/react-router");
    const { QueryClientProvider } = await import("@tanstack/react-query");
    const { render } = await import("@testing-library/react");
    const { ApplicationError } = await import("@/app/application-error");
    const auth = new FakeAuthClient({ status: "signedOut" });
    const testPlatform = platform();
    const root = createRootRouteWithContext<{ api: import("@/lib/api/client").ApiClient; auth: AuthClient; platform: Platform; queryClient: import("@tanstack/react-query").QueryClient }>()({
      component: () => { throw new Error("secret stack"); },
      errorComponent: ApplicationError
    });
    const boom = createRoute({ getParentRoute: () => root, path: "/boom", component: () => null });
    const queryClient = new (await import("@tanstack/react-query")).QueryClient();
    const api = new (await import("@/lib/api/client")).ApiClient("http://localhost:3001", auth);
    const router = createRouter({ routeTree: root.addChildren([boom]), context: { api, auth, platform: testPlatform, queryClient }, history: (await import("@tanstack/react-router")).createMemoryHistory({ initialEntries: ["/boom"] }) });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} context={{ api, auth, platform: testPlatform, queryClient }} /></QueryClientProvider>);
    expect(await screen.findByRole("button", { name: "Reload" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reset local view" })).toBeVisible();
    expect(document.body.textContent).not.toContain("secret stack");
    consoleError.mockRestore();
  });
});
