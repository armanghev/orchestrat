import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const ids = {
  organization: "00000000-0000-4000-8000-000000000001",
  otherOrganization: "00000000-0000-4000-8000-000000000002",
  alpha: "00000000-0000-4000-8000-000000000004",
  beta: "00000000-0000-4000-8000-000000000005",
  missing: "00000000-0000-4000-8000-000000000006",
  user: "00000000-0000-4000-8000-000000000007",
  task: "00000000-0000-4000-8000-000000000008",
  agent: "00000000-0000-4000-8000-000000000009"
} as const;
const now = "2026-01-01T00:00:00.000Z";

type HierarchyState = {
  organizations: Array<Record<string, unknown>>;
  projects: Record<string, Array<Record<string, unknown>>>;
  tasks?: Array<Record<string, unknown>>;
  agents?: Array<Record<string, unknown>>;
  documents?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  failingOrganizationId?: string;
  abortOrganizations?: boolean;
  unauthorized?: "once" | "always";
};

function organization(id = ids.organization, name = "Acme") {
  return {
    id,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    role: "owner",
    created_at: now,
    updated_at: now
  };
}
function project(
  id = ids.alpha,
  organizationId = ids.organization,
  name = "Alpha"
) {
  return {
    id,
    organization_id: organizationId,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    description: null,
    status: "active",
    created_at: now,
    updated_at: now,
    archived_at: null
  };
}
function populatedState(): HierarchyState {
  return {
    organizations: [organization()],
    projects: {
      [ids.organization]: [
        project(),
        project(ids.beta, ids.organization, "Beta")
      ]
    }
  };
}

async function mockHierarchy(page: Page, state: HierarchyState) {
  let rejectedOnce = false;
  await page.route("https://api.orchestrat.test/api/v1/**", async (route) => {
    expect([
      "Bearer e2e-session-token",
      "Bearer e2e-refreshed-token"
    ]).toContain(route.request().headers().authorization);
    if (
      state.unauthorized === "always" ||
      (state.unauthorized === "once" && !rejectedOnce)
    ) {
      rejectedOnce = true;
      return route.fulfill({
        status: 401,
        json: {
          error: {
            code: "UNAUTHENTICATED",
            message: "Expired",
            request_id: "e2e-401",
            details: {}
          }
        }
      });
    }
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (state.abortOrganizations && path === "/api/v1/organizations")
      return route.abort("failed");
    if (path === "/api/v1/organizations" && method === "GET")
      return route.fulfill({ json: { organizations: state.organizations } });
    if (path === "/api/v1/organizations" && method === "POST") {
      const body = route.request().postDataJSON() as { name: string };
      const created = organization(ids.organization, body.name);
      state.organizations = [created];
      return route.fulfill({ json: created });
    }
    const projectMatch = path.match(
      /^\/api\/v1\/organizations\/([^/]+)\/projects$/
    );
    if (projectMatch) {
      const organizationId = projectMatch[1];
      if (state.failingOrganizationId === organizationId && method === "GET")
        return route.abort("failed");
      if (method === "GET")
        return route.fulfill({
          json: { projects: state.projects[organizationId] ?? [] }
        });
      const body = route.request().postDataJSON() as {
        name: string;
        description?: string | null;
      };
      const created = project(ids.alpha, organizationId, body.name);
      state.projects[organizationId] = [created];
      return route.fulfill({ json: created });
    }
    if (path === "/api/v1/profile")
      return route.fulfill({
        json: {
          user_id: ids.user,
          provider: "github",
          username: "e2e_user",
          full_name: "E2E User",
          email: "e2e@example.com",
          avatar_url: null
        }
      });
    if (/^\/api\/v1\/organizations\/[^/]+\/members$/.test(path))
      return route.fulfill({
        json: {
          members: [
            {
              user_id: ids.user,
              username: "e2e_user",
              full_name: "E2E User",
              email: "e2e@example.com",
              avatar_url: null,
              role: "owner",
              created_at: now
            }
          ]
        }
      });
    if (/^\/api\/v1\/projects\/[^/]+\/tasks$/.test(path))
      return route.fulfill({
        json: {
          tasks: state.tasks ?? [],
          total: state.tasks?.length ?? 0,
          next_cursor: null
        }
      });
    if (/^\/api\/v1\/projects\/[^/]+\/agents$/.test(path))
      return route.fulfill({ json: { agents: state.agents ?? [] } });
    if (/^\/api\/v1\/projects\/[^/]+\/documents$/.test(path))
      return route.fulfill({
        json: {
          documents: state.documents ?? [],
          folders: [],
          next_cursor: null
        }
      });
    if (/^\/api\/v1\/projects\/[^/]+\/presence$/.test(path))
      return route.fulfill({ json: { agents: [] } });
    if (/^\/api\/v1\/projects\/[^/]+\/events$/.test(path))
      return route.fulfill({
        json: { events: state.events ?? [], next_cursor: null }
      });
    if (path === "/api/v1/realtime/tickets")
      return route.fulfill({
        json: { ticket: "e2e-realtime-ticket", expires_at: now }
      });
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });
}

async function seed(
  page: Page,
  authentication: "signedIn" | "signedOut" = "signedIn"
) {
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
test("@auth signed-out users continue in browser and reach setup", async ({
  page
}) => {
  await seed(page, "signedOut");
  await mockHierarchy(page, {
    organizations: [],
    projects: {}
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Coordinate agents. Keep control." })
  ).toBeVisible();
  await expectNoAxe(page);
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await expect(
    page.getByRole("heading", { name: "Create your organization" })
  ).toBeVisible();
});

test("@auth magic-link rejects invalid email, shows masked sent state, and completes the sent flow", async ({
  page
}) => {
  await seed(page, "signedOut");
  await mockHierarchy(page, {
    organizations: [],
    projects: {}
  });
  await page.goto("/");
  const email = page.getByLabel("Email address");
  await email.fill("a@.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Enter a valid email address."
  );
  await expectNoAxe(page);

  await email.fill("Person@Example.COM");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("•••@example.com");
  await expect(
    page.getByText("person@example.com", { exact: true })
  ).toHaveCount(0);
  await expectNoAxe(page);

  await page.goto("/auth/callback?code=e2e-magic-code");
  await expect(
    page.getByRole("heading", { name: "Create your organization" })
  ).toBeVisible();
  await expectNoAxe(page);
});

test("sign-out survives reload", async ({ page }) => {
  await seed(page);
  await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/overview`);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByPlaceholder("Search commands…").fill("Sign out");
  await page.getByText("Sign out", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Coordinate agents. Keep control." })
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Coordinate agents. Keep control." })
  ).toBeVisible();
});

test("a 401 forces one token refresh and retries the request", async ({
  page
}) => {
  await seed(page);
  await mockHierarchy(page, { ...populatedState(), unauthorized: "once" });
  await page.goto(`/projects/${ids.alpha}/overview`);
  await expect(page.locator('[data-slot="top-toolbar-page"]')).toHaveText(
    "Overview"
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number(localStorage.getItem("orchestrat.e2e.refreshes") ?? "0")
      )
    )
    .toBe(1);
});

test("a repeated 401 expires the session and recovery remains signed out after reload", async ({
  page
}) => {
  await seed(page);
  await mockHierarchy(page, { ...populatedState(), unauthorized: "always" });
  await page.goto(`/projects/${ids.alpha}/overview`);
  await expect(
    page.getByRole("heading", { name: "Coordinate agents. Keep control." })
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Coordinate agents. Keep control." })
  ).toBeVisible();
  await expectNoAxe(page);
});

test("the e2e adapter rejects arbitrary persisted auth modes", async ({
  page
}) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("orchestrat.e2e.auth", "unsafe-mode:<script>");
    sessionStorage.setItem("orchestrat.e2e.seeded", "true");
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Coordinate agents. Keep control." })
  ).toBeVisible();
});

test("creates organization and project sequentially", async ({ page }) => {
  await seed(page);
  await mockHierarchy(page, {
    organizations: [],
    projects: {}
  });
  await page.goto("/setup");
  await page.getByLabel("Organization name").fill("Acme");
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.getByLabel("Project name").fill("Alpha");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.locator('[data-slot="top-toolbar-page"]')).toHaveText(
    "Overview"
  );
  await expectNoAxe(page);
});

test("project shell switches projects and persists recency", async ({
  page
}) => {
  await seed(page);
  await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/overview`);
  await expect(
    page.getByRole("complementary", { name: "Project navigation" })
  ).toBeVisible();
  await expect(page.getByRole("banner")).toContainText("Alpha");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByPlaceholder("Search commands…").fill("Beta");
  await page.getByText("Open Beta", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.beta}/overview$`));
  await page.reload();
  await expect(page.getByRole("banner")).toContainText("Beta");
  await expect
    .poll(() =>
      page.evaluate(
        (projectId) =>
          JSON.parse(localStorage.getItem("orchestrat.preferences.v1") ?? "{}")
            .recentProjectIds?.[0] === projectId,
        ids.beta
      )
    )
    .toBe(true);
  await expectNoAxe(page);
});

test("@phone creates, edits, and comments on a task with human and agent authors", async ({
  page
}) => {
  await seed(page);
  await mockHierarchy(page, populatedState());
  let task: Record<string, unknown> | null = null;
  let comments = [
    {
      id: "00000000-0000-4000-8000-000000000010",
      task_id: ids.task,
      author: {
        type: "agent",
        id: ids.agent,
        user_id: null,
        agent_id: ids.agent,
        username: null,
        full_name: "Codex",
        avatar_url: null
      },
      body_markdown: "Agent context is ready.",
      created_at: now
    }
  ];
  const taskCard = () => ({
    ...task,
    comment_count: comments.length,
    unresolved_blocker_count: 0
  });
  await page.route(
    `https://api.orchestrat.test/api/v1/projects/${ids.alpha}/tasks**`,
    async (route) => {
      if (route.request().method() === "GET")
        return route.fulfill({
          json: {
            tasks: task ? [taskCard()] : [],
            total: task ? 1 : 0,
            next_cursor: null
          }
        });
      const body = route.request().postDataJSON() as Record<string, unknown>;
      task = {
        id: ids.task,
        project_id: ids.alpha,
        key: "ALPHA-1",
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? "medium",
        status: body.status ?? "backlog",
        position: 0,
        version: 1,
        created_by: { type: "human", id: ids.user },
        created_by_user_id: ids.user,
        created_at: now,
        updated_at: now,
        started_at: null,
        completed_at: null,
        cancelled_at: null
      };
      return route.fulfill({ json: task });
    }
  );
  await page.route(
    `https://api.orchestrat.test/api/v1/tasks/${ids.task}**`,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path.endsWith("/comments")) {
        if (method === "GET")
          return route.fulfill({ json: { comments, next_cursor: null } });
        const body = route.request().postDataJSON() as {
          body_markdown: string;
        };
        const created = {
          id: "00000000-0000-4000-8000-000000000011",
          task_id: ids.task,
          author: {
            type: "human",
            id: ids.user,
            user_id: ids.user,
            agent_id: null,
            username: "e2e_user",
            full_name: "E2E User",
            avatar_url: null
          },
          body_markdown: body.body_markdown,
          created_at: now
        };
        comments = [...comments, created];
        return route.fulfill({ json: created });
      }
      if (path.endsWith("/dependencies"))
        return route.fulfill({ json: { depends_on: [], blocks: [] } });
      if (method === "GET") return route.fulfill({ json: task });
      const body = route.request().postDataJSON() as Record<string, unknown>;
      task = {
        ...task,
        ...body,
        version: Number(task!.version) + 1,
        updated_at: now
      };
      delete task.expected_version;
      return route.fulfill({ json: task });
    }
  );
  await page.goto(`/projects/${ids.alpha}/tasks`);
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByLabel("Title").fill("Ship editor");
  await page.getByLabel("Description (Markdown)").fill("Use MDXEditor");
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(
    page.getByRole("heading", { name: "Ship editor" })
  ).toBeVisible();
  await expect(page.getByText("Codex (agent)", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Agent context is ready.", { exact: true })
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Task details" })
    .getByLabel("Title", { exact: true })
    .fill("Ship rich editor");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("heading", { name: "Ship rich editor" })
  ).toBeVisible();
  await page.getByLabel("Add comment").fill("Human review complete.");
  await page.getByRole("button", { name: "Comment" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Task details" })
      .getByText("E2E User", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText("Human review complete.", { exact: true })
  ).toBeVisible();
  await expectNoAxe(page);
});

test("@phone task details render Markdown and edit dependencies", async ({
  page
}) => {
  const task = {
    id: ids.task,
    project_id: ids.alpha,
    key: "ALPHA-1",
    title: "Ship phone controls",
    description: "**Ready** for the [mobile guide](https://example.com/guide).",
    priority: "medium",
    status: "ready",
    position: 0,
    version: 1,
    created_by: { type: "human", id: ids.user },
    created_by_user_id: ids.user,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    comment_count: 0,
    unresolved_blocker_count: 0
  };
  const dependency = {
    ...task,
    id: "00000000-0000-4000-8000-000000000012",
    key: "ALPHA-2",
    title: "Publish the guide",
    position: 1,
    description: null
  };
  let dependsOn = false;
  await seed(page);
  await mockHierarchy(page, { ...populatedState(), tasks: [task, dependency] });
  await page.route(
    `https://api.orchestrat.test/api/v1/tasks/${ids.task}**`,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (path.endsWith("/comments"))
        return route.fulfill({ json: { comments: [], next_cursor: null } });
      if (path.endsWith("/dependencies")) {
        if (method === "GET")
          return route.fulfill({
            json: { depends_on: dependsOn ? [dependency] : [], blocks: [] }
          });
        dependsOn = true;
        task.version++;
        return route.fulfill({ json: task });
      }
      if (path.endsWith(`/dependencies/${dependency.id}`)) {
        dependsOn = false;
        task.version++;
        return route.fulfill({ json: task });
      }
      return route.fulfill({ json: task });
    }
  );
  await page.goto(`/projects/${ids.alpha}/tasks?task=${ids.task}`);
  await expect(
    page.getByRole("dialog", { name: "Task details" }).getByRole("link", {
      name: "mobile guide"
    })
  ).toHaveAttribute("href", "https://example.com/guide");
  await page.getByLabel("Add task dependency").selectOption(dependency.id);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    page.getByText("Publish the guide", { exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Task details" }).getByText("None", {
      exact: true
    })
  ).toBeVisible();
  expect(
    await page
      .locator("#main-content")
      .evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  await expectNoAxe(page);
});

test("@phone activity resolves people and task links", async ({ page }) => {
  const task = {
    id: ids.task,
    project_id: ids.alpha,
    key: "ALPHA-7",
    title: "Make activity readable",
    description: null,
    priority: "medium",
    status: "done",
    position: 0,
    version: 1,
    created_by: { type: "human", id: ids.user },
    created_by_user_id: ids.user,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: now,
    cancelled_at: null,
    comment_count: 0,
    unresolved_blocker_count: 0
  };
  await seed(page);
  await mockHierarchy(page, {
    ...populatedState(),
    tasks: [task],
    agents: [
      {
        id: ids.agent,
        project_id: ids.alpha,
        name: "Terra",
        status: "active",
        created_at: now,
        updated_at: now,
        revoked_at: null
      }
    ],
    events: [
      {
        id: 2,
        project_id: ids.alpha,
        type: "claim.completed",
        actor_agent_id: ids.agent,
        actor_user_id: null,
        entity_id: "00000000-0000-4000-8000-000000000013",
        payload: { task_id: ids.task },
        occurred_at: now
      },
      {
        id: 1,
        project_id: ids.alpha,
        type: "task.done",
        actor_agent_id: null,
        actor_user_id: ids.user,
        entity_id: ids.task,
        payload: {},
        occurred_at: now
      }
    ]
  });
  await page.goto(`/projects/${ids.alpha}/activity`);
  await expect(
    page.getByText("Terra completed", { exact: false })
  ).toBeVisible();
  await expect(
    page.getByText("E2E User completed", { exact: false })
  ).toBeVisible();
  const taskLinks = page.getByRole("link", { name: "ALPHA-7" });
  await expect(taskLinks).toHaveCount(2);
  await expect(taskLinks.first()).toHaveAttribute(
    "href",
    `/projects/${ids.alpha}/tasks?task=${ids.task}`
  );
  expect(
    await page
      .locator("#main-content")
      .evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  await expectNoAxe(page);
});

test("@phone settings keep local agent commands usable", async ({ page }) => {
  await seed(page);
  await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/settings`);
  await expect(
    page.getByText("The browser cannot inspect local agent configuration.")
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Copy setup command" })
  ).toBeVisible();
  await expect(
    page.getByText("ORCHESTRAT_API_URL", { exact: false }).first()
  ).toBeVisible();
  expect(
    await page
      .locator("#main-content")
      .evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  await expectNoAxe(page);
});

test("theme preference survives reload for Dark and System light", async ({
  page
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await seed(page);
  await mockHierarchy(page, populatedState());
  await page.goto("/profile");
  await page.getByText("Dark", { exact: true }).click();
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem("orchestrat.preferences.v1") ?? "{}")
        .theme === "dark"
  );
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(
    page.getByRole("heading", { name: "Profile", exact: true })
  ).toBeVisible();
  await expectNoAxe(page);
  await page.getByText("System", { exact: true }).click();
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem("orchestrat.preferences.v1") ?? "{}")
        .theme === "system"
  );
  await page.reload();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(
    page.getByRole("heading", { name: "Profile", exact: true })
  ).toBeVisible();
  await expectNoAxe(page);
});

test("preserves successful projects when one hierarchy branch fails", async ({
  page
}) => {
  const state = populatedState();
  state.organizations.push(
    organization(ids.otherOrganization, "Broken organization")
  );
  state.projects[ids.otherOrganization] = [
    project(ids.missing, ids.otherOrganization, "Hidden")
  ];
  state.failingOrganizationId = ids.otherOrganization;
  await seed(page);
  await mockHierarchy(page, state);
  await page.goto(`/projects/${ids.alpha}/overview`);
  await expect(page.locator('[data-slot="top-toolbar-page"]')).toHaveText(
    "Overview"
  );
  await expect(
    page.getByText("Some projects could not be loaded.")
  ).toBeVisible();
});

test("does not silently switch when project access is lost", async ({
  page
}) => {
  await seed(page);
  await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.missing}/overview`);
  await expect(
    page.getByRole("heading", { name: "Project access unavailable" })
  ).toBeVisible();
  await expect(page.getByText(ids.missing)).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${ids.missing}/overview$`)
  );
});

test("shows explicit network retry state when the API is unavailable", async ({
  page
}) => {
  await seed(page);
  await mockHierarchy(page, {
    organizations: [],
    projects: {},
    abortOrganizations: true
  });
  await page.goto(`/projects/${ids.alpha}/overview`);
  await expect(
    page.getByRole("heading", { name: "Project unavailable" })
  ).toBeVisible();
  await expect(
    page.getByText(
      "We couldn’t reach the Dashboard API. Check your connection and try again."
    )
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("command palette search selects a project and restores focus", async ({
  page
}) => {
  await seed(page);
  await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/overview`);
  await expect(page.locator('[data-slot="top-toolbar-page"]')).toHaveText(
    "Overview"
  );
  await page.waitForTimeout(50);
  await page.keyboard.down("Meta");
  await page.keyboard.press("k");
  await page.keyboard.up("Meta");
  await page.getByPlaceholder("Search commands…").fill("Beta");
  await page.getByText("Open Beta", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.beta}/overview$`));
  const trigger = page.getByRole("button", {
    name: "Search",
    exact: true
  });
  await trigger.focus();
  await page.keyboard.press("Meta+k");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("compact shell collapses and restores sidebar without horizontal overflow", async ({
  page
}) => {
  await seed(page);
  await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/overview`);
  const main = page.locator("#main-content");
  expect(
    await main.evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "Restore sidebar" })
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Project navigation" })
      .locator('[data-slot="sidebar"]')
      .first()
  ).toHaveCSS("width", "48px");
  await expect(page.getByRole("button", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("button", { name: /E2E User/ })).toBeVisible();
  await page.getByRole("button", { name: "Restore sidebar" }).click();
  expect(
    await main.evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  const centers = await page
    .locator(
      'header [data-slot="sidebar-trigger"], header [data-slot="separator"], header [data-slot="breadcrumb"], header button[aria-haspopup="menu"]'
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return rect.y + rect.height / 2;
      })
    );
  expect(centers).toHaveLength(6);
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
});

test("has no axe violations on setup, overview, Tasks, profile, and themes", async ({
  page
}) => {
  await seed(page);
  await mockHierarchy(page, {
    organizations: [],
    projects: {}
  });
  await page.goto("/setup");
  await expect(
    page.getByRole("heading", { name: "Create your organization" })
  ).toBeVisible();
  await expectNoAxe(page);
  await page.unrouteAll();
  await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/overview`);
  await expect(page.locator('[data-slot="top-toolbar-page"]')).toHaveText(
    "Overview"
  );
  await expectNoAxe(page);
  await page.goto(`/projects/${ids.alpha}/tasks`);
  await expect(page.locator('[data-slot="top-toolbar-page"]')).toHaveText(
    "Tasks"
  );
  await expectNoAxe(page);
  await page.goto("/profile");
  await expect(
    page.getByRole("heading", { name: "Profile", exact: true })
  ).toBeVisible();
  await expectNoAxe(page);
  await page.getByText("Dark", { exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.waitForTimeout(250);
  await expectNoAxe(page);
  await page.getByText("Light", { exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.waitForTimeout(250);
  await expectNoAxe(page);
});

test("mobile navigation opens, changes pages, and closes without overflow", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/overview`);
  for (const name of ["Tasks", "Agents", "Activity", "Overview"]) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator('[data-slot="top-toolbar-page"]')).toHaveText(
      name
    );
    await expect(
      page.getByRole("dialog", { name: "Sidebar" })
    ).not.toBeVisible();
    expect(
      await page
        .locator("#main-content")
        .evaluate((element) => element.scrollWidth <= element.clientWidth)
    ).toBe(true);
  }
  await expectNoAxe(page);
});
