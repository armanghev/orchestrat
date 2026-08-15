import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const ids = {
  organization: "00000000-0000-4000-8000-000000000001",
  workspace: "00000000-0000-4000-8000-000000000002",
  otherWorkspace: "00000000-0000-4000-8000-000000000003",
  alpha: "00000000-0000-4000-8000-000000000004",
  beta: "00000000-0000-4000-8000-000000000005",
  missing: "00000000-0000-4000-8000-000000000006"
} as const;
const now = "2026-01-01T00:00:00.000Z";

type HierarchyState = {
  organizations: Array<Record<string, unknown>>;
  workspaces: Record<string, Array<Record<string, unknown>>>;
  projects: Record<string, Array<Record<string, unknown>>>;
  failingWorkspaceId?: string;
  abortOrganizations?: boolean;
  unauthorized?: "once" | "always";
};

function organization(id = ids.organization, name = "Acme") {
  return { id, name, slug: name.toLowerCase().replaceAll(" ", "-"), role: "owner", created_at: now, updated_at: now };
}
function workspace(id = ids.workspace, organizationId = ids.organization, name = "Product") {
  return { id, organization_id: organizationId, name, slug: name.toLowerCase().replaceAll(" ", "-"), created_at: now, updated_at: now };
}
function project(id = ids.alpha, workspaceId = ids.workspace, name = "Alpha") {
  return { id, workspace_id: workspaceId, name, slug: name.toLowerCase().replaceAll(" ", "-"), description: null, status: "active", created_at: now, updated_at: now, archived_at: null };
}
function populatedState(): HierarchyState {
  return { organizations: [organization()], workspaces: { [ids.organization]: [workspace()] }, projects: { [ids.workspace]: [project(), project(ids.beta, ids.workspace, "Beta")] } };
}

async function mockHierarchy(page: Page, state: HierarchyState) {
  let rejectedOnce = false;
  await page.route("https://api.orchestrat.test/api/v1/**", async (route) => {
    expect(["Bearer e2e-session-token", "Bearer e2e-refreshed-token"]).toContain(route.request().headers().authorization);
    if (state.unauthorized === "always" || (state.unauthorized === "once" && !rejectedOnce)) {
      rejectedOnce = true;
      return route.fulfill({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "Expired", request_id: "e2e-401", details: {} } } });
    }
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (state.abortOrganizations && path === "/api/v1/organizations") return route.abort("failed");
    if (path === "/api/v1/organizations" && method === "GET") return route.fulfill({ json: { organizations: state.organizations } });
    if (path === "/api/v1/organizations" && method === "POST") {
      const body = route.request().postDataJSON() as { name: string };
      const created = organization(ids.organization, body.name);
      state.organizations = [created];
      return route.fulfill({ json: created });
    }
    const workspaceMatch = path.match(/^\/api\/v1\/organizations\/([^/]+)\/workspaces$/);
    if (workspaceMatch) {
      const organizationId = workspaceMatch[1];
      if (method === "GET") return route.fulfill({ json: { workspaces: state.workspaces[organizationId] ?? [] } });
      const body = route.request().postDataJSON() as { name: string };
      const created = workspace(ids.workspace, organizationId, body.name);
      state.workspaces[organizationId] = [created];
      return route.fulfill({ json: created });
    }
    const projectMatch = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/projects$/);
    if (projectMatch) {
      const workspaceId = projectMatch[1];
      if (state.failingWorkspaceId === workspaceId && method === "GET") return route.abort("failed");
      if (method === "GET") return route.fulfill({ json: { projects: state.projects[workspaceId] ?? [] } });
      const body = route.request().postDataJSON() as { name: string; description?: string | null };
      const created = project(ids.alpha, workspaceId, body.name);
      state.projects[workspaceId] = [created];
      return route.fulfill({ json: created });
    }
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });
}

async function seed(page: Page, authentication: "signedIn" | "signedOut" = "signedIn") {
  await page.addInitScript((value) => {
    if (sessionStorage.getItem("orchestrat.e2e.seeded")) return;
    localStorage.clear();
    localStorage.setItem("orchestrat.e2e.auth", value);
    sessionStorage.setItem("orchestrat.e2e.seeded", "true");
  }, authentication);
}
async function expectNoAxe(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

// Each test starts from localStorage so the in-browser auth adapter, router, and token-bearing API client are exercised together.
test("signed-out users continue in browser and reach setup", async ({ page }) => {
  await seed(page, "signedOut");
  await mockHierarchy(page, { organizations: [], workspaces: {}, projects: {} });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Coordinate agents. Keep control." })).toBeVisible();
  await expectNoAxe(page);
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible();
});

test("magic-link rejects invalid email, shows masked sent state, and completes the sent flow", async ({ page }) => {
  await seed(page, "signedOut");
  await mockHierarchy(page, { organizations: [], workspaces: {}, projects: {} });
  await page.goto("/");
  const email = page.getByLabel("Email address");
  await email.fill("a@.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a valid email address.");
  await expectNoAxe(page);

  await email.fill("Person@Example.COM");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("•••@example.com");
  await expect(page.getByText("person@example.com", { exact: true })).toHaveCount(0);
  await expectNoAxe(page);

  await page.goto("/auth/callback?code=e2e-magic-code");
  await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible();
});

test("sign-out survives reload", async ({ page }) => {
  await seed(page);
  await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/overview`);
  await page.getByRole("button", { name: /Command/ }).click();
  await page.getByPlaceholder("Search commands…").fill("Sign out");
  await page.getByText("Sign out", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Coordinate agents. Keep control." })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Coordinate agents. Keep control." })).toBeVisible();
});

test("a 401 forces one token refresh and retries the request", async ({ page }) => {
  await seed(page);
  await mockHierarchy(page, { ...populatedState(), unauthorized: "once" });
  await page.goto(`/projects/${ids.alpha}/overview`);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Number(localStorage.getItem("orchestrat.e2e.refreshes") ?? "0"))).toBe(1);
});

test("a repeated 401 expires the session and recovery remains signed out after reload", async ({ page }) => {
  await seed(page);
  await mockHierarchy(page, { ...populatedState(), unauthorized: "always" });
  await page.goto(`/projects/${ids.alpha}/overview`);
  await expect(page.getByRole("heading", { name: "Coordinate agents. Keep control." })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Coordinate agents. Keep control." })).toBeVisible();
  await expectNoAxe(page);
});

test("the e2e adapter rejects arbitrary persisted auth modes", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("orchestrat.e2e.auth", "unsafe-mode:<script>");
    sessionStorage.setItem("orchestrat.e2e.seeded", "true");
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Coordinate agents. Keep control." })).toBeVisible();
});

test("creates organization, workspace, and project sequentially", async ({ page }) => {
  await seed(page);
  await mockHierarchy(page, { organizations: [], workspaces: {}, projects: {} });
  await page.goto("/setup");
  await page.getByLabel("Organization name").fill("Acme");
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.getByLabel("Workspace name").fill("Product");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.getByLabel("Project name").fill("Alpha");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expectNoAxe(page);
});

test("project shell switches projects and persists recency", async ({ page }) => {
  await seed(page); await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/overview`);
  await expect(page.getByRole("complementary", { name: "Projects" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Project navigation" })).toBeVisible();
  await expect(page.getByRole("banner")).toContainText("Alpha");
  await page.getByRole("button", { name: /Command/ }).click();
  await page.getByPlaceholder("Search commands…").fill("Beta");
  await page.getByText("Open Beta", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.beta}/overview$`));
  await page.reload();
  await expect(page.getByRole("link", { name: "Open Beta" })).toHaveAttribute("aria-current", "page");
  await expectNoAxe(page);
});

test("Tasks is explicitly unavailable without fake task controls", async ({ page }) => {
  await seed(page); await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/tasks`);
  await expect(page.getByText("Task service unavailable")).toBeVisible();
  await expect(page.getByText("The task API is not part of this dashboard build.")).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /create task/i })).toHaveCount(0);
  await page.getByRole("link", { name: "Return to overview" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.alpha}/overview$`));
  await expectNoAxe(page);
});

test("theme preference survives reload for Dark and System light", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await seed(page); await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/overview`);
  await page.getByRole("button", { name: "Open preferences" }).click();
  await page.getByRole("radio", { name: "Dark" }).check({ force: true });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("orchestrat.preferences.v1") ?? "{}").theme === "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible();
  await expectNoAxe(page);
  await page.getByRole("radio", { name: "System" }).check({ force: true });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("orchestrat.preferences.v1") ?? "{}").theme === "system");
  await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible();
  await expectNoAxe(page);
});

test("preserves successful projects when one hierarchy branch fails", async ({ page }) => {
  const state = populatedState();
  state.workspaces[ids.organization].push(workspace(ids.otherWorkspace, ids.organization, "Broken"));
  state.projects[ids.otherWorkspace] = [project(ids.missing, ids.otherWorkspace, "Hidden")];
  state.failingWorkspaceId = ids.otherWorkspace;
  await seed(page); await mockHierarchy(page, state);
  await page.goto(`/projects/${ids.alpha}/overview`);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Some projects could not be loaded.");
});

test("does not silently switch when project access is lost", async ({ page }) => {
  await seed(page); await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.missing}/overview`);
  await expect(page.getByRole("heading", { name: "Project access unavailable" })).toBeVisible();
  await expect(page.getByText(ids.missing)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.missing}/overview$`));
});

test("shows explicit network retry state when the API is unavailable", async ({ page }) => {
  await seed(page); await mockHierarchy(page, { organizations: [], workspaces: {}, projects: {}, abortOrganizations: true });
  await page.goto(`/projects/${ids.alpha}/overview`);
  await expect(page.getByRole("heading", { name: "Project unavailable" })).toBeVisible();
  await expect(page.getByText("We couldn’t reach the Dashboard API. Check your connection and try again.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("command palette search selects a project and restores focus", async ({ page }) => {
  await seed(page); await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/overview`);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await page.waitForTimeout(50);
  await page.keyboard.down("Meta"); await page.keyboard.press("k"); await page.keyboard.up("Meta");
  await page.getByPlaceholder("Search commands…").fill("Beta");
  await page.getByText("Open Beta", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.beta}/overview$`));
  const trigger = page.getByRole("button", { name: /Command/ });
  await trigger.focus(); await page.keyboard.press("Meta+k");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("compact shell collapses and restores sidebar without horizontal overflow", async ({ page }) => {
  await seed(page); await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/overview`);
  const main = page.locator("#main-content");
  expect(await main.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByRole("button", { name: "Restore sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Restore sidebar" }).click();
  expect(await main.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("has no axe violations on setup, overview, Tasks, Preferences, and themes", async ({ page }) => {
  await seed(page); await mockHierarchy(page, { organizations: [], workspaces: {}, projects: {} });
  await page.goto("/setup"); await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible(); await expectNoAxe(page);
  await page.unrouteAll(); await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/overview`); await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible(); await expectNoAxe(page);
  await page.goto(`/projects/${ids.alpha}/tasks`); await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible(); await expectNoAxe(page);
  await page.goto("/preferences"); await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible(); await expectNoAxe(page);
  await page.getByRole("radio", { name: "Dark" }).check({ force: true }); await expectNoAxe(page);
  await page.getByRole("radio", { name: "Light" }).check({ force: true }); await expectNoAxe(page);
});
