import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

  it("allows an authenticated user into the setup route", async () => {
    const view = await renderDashboardRoute({ path: "/setup", auth: new FakeAuthClient({ status: "signedIn" }), platform: platform() });
    await waitFor(() => expect(view.router.state.location.pathname).toBe("/setup"));
    expect(await screen.findByText("Setup")).toBeVisible();
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
