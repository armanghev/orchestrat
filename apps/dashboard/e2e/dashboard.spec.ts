import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
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
  chats?: Array<Record<string, unknown>>;
  messageCandidates?: Array<Record<string, unknown>>;
  messages?: Record<string, Array<Record<string, unknown>>>;
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
  let lastCreatedChat:
    | {
        kind: "direct" | "group";
        name?: string;
        participants: Array<{ type: "human" | "agent"; id: string }>;
      }
    | undefined;
  let lastSentMessage:
    | {
        body_markdown: string;
        mentions: Array<{ type: "human" | "agent"; id: string }>;
        document_ids: string[];
      }
    | undefined;
  const sockets = new Map<string, WebSocketRoute>();
  await page.routeWebSocket(
    "wss://api.orchestrat.test/api/v1/realtime/**",
    (ws) => {
      const projectId = new URL(ws.url()).pathname.split("/").at(-1);
      if (projectId) sockets.set(projectId, ws);
    }
  );
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
    if (/^\/api\/v1\/projects\/[^/]+\/members$/.test(path))
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
    if (/^\/api\/v1\/projects\/[^/]+\/invitations$/.test(path))
      return route.fulfill({ json: { invitations: [] } });
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
    const projectChats = path.match(/^\/api\/v1\/projects\/([^/]+)\/chats$/);
    if (projectChats) {
      if (method === "GET")
        return route.fulfill({
          json: {
            chats: (state.chats ?? []).filter(
              (chat) => chat.project_id === projectChats[1]
            )
          }
        });
      const body = route.request().postDataJSON() as {
        kind: "direct" | "group";
        name?: string;
        participants: Array<{ type: "human" | "agent"; id: string }>;
      };
      lastCreatedChat = body;
      const candidates = [
        {
          type: "human",
          id: ids.user,
          name: "E2E User",
          avatar_url: null
        },
        ...(state.messageCandidates ?? [])
      ];
      const created = {
        id: "00000000-0000-4000-8000-000000000030",
        project_id: projectChats[1],
        kind: body.kind,
        name: body.kind === "group" ? (body.name ?? null) : null,
        has_human: true,
        creator: { type: "human", id: ids.user },
        participants: [
          candidates[0],
          ...body.participants.map(
            (participant) =>
              candidates.find(
                (candidate) =>
                  candidate.type === participant.type &&
                  candidate.id === participant.id
              ) ?? participant
          )
        ],
        is_participant: true,
        can_manage: true,
        can_join: false,
        last_sequence: 0,
        last_read_sequence: 0,
        unread_count: 0,
        mention_count: 0,
        created_at: now,
        updated_at: now
      };
      state.chats ??= [];
      state.chats.push(created);
      state.messages ??= {};
      state.messages[created.id] = [];
      return route.fulfill({ status: 201, json: created });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/message-candidates$/.test(path))
      return route.fulfill({
        json: { candidates: state.messageCandidates ?? [] }
      });
    if (/^\/api\/v1\/projects\/[^/]+\/inbox$/.test(path))
      return route.fulfill({ json: { unread_chats: [] } });
    const chat = path.match(/^\/api\/v1\/chats\/([^/]+)$/);
    if (chat && method === "GET") {
      const value = state.chats?.find(({ id }) => id === chat[1]);
      return value
        ? route.fulfill({ json: value })
        : route.fulfill({
            status: 404,
            json: { error: { code: "NOT_FOUND" } }
          });
    }
    const chatJoin = path.match(/^\/api\/v1\/chats\/([^/]+)\/join$/);
    if (chatJoin && method === "POST") {
      const current = state.chats?.find(({ id }) => id === chatJoin[1]);
      if (!current)
        return route.fulfill({
          status: 404,
          json: { error: { code: "NOT_FOUND" } }
        });
      const participants = Array.isArray(current.participants)
        ? current.participants
        : [];
      const joined = {
        ...current,
        has_human: true,
        participants: [
          ...participants,
          { type: "human", id: ids.user, name: "E2E User", avatar_url: null }
        ],
        is_participant: true,
        can_join: false,
        updated_at: now
      };
      state.chats = state.chats?.map((chat) =>
        chat.id === chatJoin[1] ? joined : chat
      );
      return route.fulfill({ json: joined });
    }
    const chatMessages = path.match(/^\/api\/v1\/chats\/([^/]+)\/messages$/);
    if (chatMessages) {
      const chatId = chatMessages[1];
      if (method === "GET")
        return route.fulfill({
          json: {
            messages: state.messages?.[chatId] ?? [],
            has_more: false,
            next_after: null,
            next_before: null
          }
        });
      const body = route.request().postDataJSON() as {
        body_markdown: string;
        mentions: Array<{ type: "human" | "agent"; id: string }>;
        document_ids: string[];
      };
      lastSentMessage = body;
      const participants = [
        {
          type: "human",
          id: ids.user,
          name: "E2E User",
          avatar_url: null
        },
        ...(state.messageCandidates ?? [])
      ];
      const created = {
        id: "00000000-0000-4000-8000-000000000031",
        chat_id: chatId,
        project_id: ids.alpha,
        sequence: (state.messages?.[chatId]?.length ?? 0) + 1,
        author: { type: "human", id: ids.user, name: "E2E User" },
        body_markdown: body.body_markdown,
        mentions: body.mentions.map((mention) => {
          const participant = participants.find(
            (candidate) =>
              candidate.type === mention.type && candidate.id === mention.id
          );
          return {
            type: mention.type,
            id: mention.id,
            name: participant?.name ?? "Participant"
          };
        }),
        documents: body.document_ids.flatMap((id) => {
          const document = state.documents?.find(
            (candidate) => candidate.id === id
          );
          return document && typeof document.path === "string"
            ? [{ id, path: document.path }]
            : [];
        }),
        created_at: now
      };
      state.messages ??= {};
      (state.messages[chatId] ??= []).push(created);
      return route.fulfill({ json: created });
    }
    if (/^\/api\/v1\/chats\/[^/]+\/read$/.test(path))
      return route.fulfill({ json: { last_read_sequence: 0 } });
    if (/^\/api\/v1\/projects\/[^/]+\/presence$/.test(path))
      return route.fulfill({ json: { agents: [] } });
    if (/^\/api\/v1\/projects\/[^/]+\/events$/.test(path))
      return route.fulfill({
        json: { events: state.events ?? [], next_cursor: null }
      });
    if (path === "/api/v1/realtime/tickets")
      return route.fulfill({
        json: { ticket: "e".repeat(32), expires_at: now }
      });
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });
  return {
    getChat: (chatId: string) => state.chats?.find(({ id }) => id === chatId),
    getLastCreatedChat: () => lastCreatedChat,
    getLastSentMessage: () => lastSentMessage,
    getSocket: (projectId: string) => sockets.get(projectId)
  };
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
    page
      .getByRole("complementary", { name: "Project navigation" })
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

test("messaging creates typed groups, sends Markdown references, protects observers, and opens cross-project notifications", async ({
  page
}, testInfo) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const directChat = {
    id: "00000000-0000-4000-8000-000000000026",
    project_id: ids.alpha,
    kind: "direct",
    name: null,
    has_human: true,
    creator: { type: "human", id: ids.user },
    participants: [
      { type: "human", id: ids.user, name: "E2E User", avatar_url: null },
      {
        type: "human",
        id: "00000000-0000-4000-8000-000000000027",
        name: "Alice",
        avatar_url: null
      }
    ],
    is_participant: true,
    can_manage: false,
    can_join: false,
    last_sequence: 1,
    last_read_sequence: 1,
    unread_count: 0,
    mention_count: 0,
    created_at: now,
    updated_at: now
  };
  const observerChat = {
    id: "00000000-0000-4000-8000-000000000028",
    project_id: ids.alpha,
    kind: "direct",
    name: null,
    has_human: false,
    creator: { type: "agent", id: ids.agent },
    participants: [
      { type: "agent", id: ids.agent, name: "Build Agent", avatar_url: null },
      {
        type: "agent",
        id: "00000000-0000-4000-8000-000000000010",
        name: "Review Agent",
        avatar_url: null
      }
    ],
    is_participant: false,
    can_manage: false,
    can_join: false,
    last_sequence: 1,
    last_read_sequence: 0,
    unread_count: 0,
    mention_count: 0,
    created_at: now,
    updated_at: now
  };
  const joinableGroup = {
    id: "00000000-0000-4000-8000-000000000036",
    project_id: ids.alpha,
    kind: "group",
    name: "Agent deployment",
    has_human: false,
    creator: { type: "agent", id: ids.agent },
    participants: [
      { type: "agent", id: ids.agent, name: "Build Agent", avatar_url: null },
      {
        type: "agent",
        id: "00000000-0000-4000-8000-000000000010",
        name: "Review Agent",
        avatar_url: null
      }
    ],
    is_participant: false,
    can_manage: false,
    can_join: true,
    last_sequence: 1,
    last_read_sequence: 0,
    unread_count: 0,
    mention_count: 0,
    created_at: now,
    updated_at: now
  };
  const betaChat = {
    id: "00000000-0000-4000-8000-000000000038",
    project_id: ids.beta,
    kind: "direct",
    name: null,
    has_human: true,
    creator: { type: "human", id: ids.user },
    participants: [
      { type: "human", id: ids.user, name: "E2E User", avatar_url: null },
      { type: "agent", id: ids.agent, name: "Build Agent", avatar_url: null }
    ],
    is_participant: true,
    can_manage: false,
    can_join: false,
    last_sequence: 1,
    last_read_sequence: 1,
    unread_count: 0,
    mention_count: 0,
    created_at: now,
    updated_at: now
  };
  await seed(page);
  const state = await mockHierarchy(page, {
    ...populatedState(),
    chats: [directChat, observerChat, joinableGroup, betaChat],
    messageCandidates: [
      directChat.participants[1],
      { type: "agent", id: ids.agent, name: "Build Agent", avatar_url: null }
    ],
    documents: [
      {
        id: "00000000-0000-4000-8000-000000000029",
        project_id: ids.alpha,
        path: "release-notes.md",
        current_revision: 1,
        archived_at: null,
        created_by: { type: "human", id: ids.user },
        created_at: now,
        updated_at: now
      }
    ],
    messages: {
      [directChat.id]: [
        {
          id: "00000000-0000-4000-8000-000000000032",
          chat_id: directChat.id,
          project_id: ids.alpha,
          sequence: 1,
          author: {
            type: "human",
            id: directChat.participants[1].id,
            name: "Alice"
          },
          body_markdown: "Existing direct message",
          mentions: [],
          documents: [],
          created_at: now
        }
      ],
      [observerChat.id]: [
        {
          id: "00000000-0000-4000-8000-000000000033",
          chat_id: observerChat.id,
          project_id: ids.alpha,
          sequence: 1,
          author: { type: "agent", id: ids.agent, name: "Build Agent" },
          body_markdown: "Observer history",
          mentions: [],
          documents: [],
          created_at: now
        }
      ],
      [joinableGroup.id]: [
        {
          id: "00000000-0000-4000-8000-000000000037",
          chat_id: joinableGroup.id,
          project_id: ids.alpha,
          sequence: 1,
          author: { type: "agent", id: ids.agent, name: "Build Agent" },
          body_markdown: "Joinable agent group",
          mentions: [],
          documents: [],
          created_at: now
        }
      ],
      [betaChat.id]: [
        {
          id: "00000000-0000-4000-8000-000000000039",
          chat_id: betaChat.id,
          project_id: ids.beta,
          sequence: 1,
          author: { type: "agent", id: ids.agent, name: "Build Agent" },
          body_markdown: "Cross-project update",
          mentions: [{ type: "human", id: ids.user, name: "E2E User" }],
          documents: [],
          created_at: now
        }
      ]
    }
  });
  await page.goto(`/projects/${ids.alpha}/messages`);
  await page.getByRole("button", { name: "New message" }).click();
  await page.getByRole("button", { name: /Alice.*Human/ }).click();
  await page.getByRole("button", { name: /Build Agent.*Agent/ }).click();
  await page.getByRole("textbox", { name: "Group name" }).fill("Release team");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page).toHaveURL(/chat=00000000-0000-4000-8000-000000000030/);
  expect(state.getLastCreatedChat()).toEqual({
    kind: "group",
    name: "Release team",
    participants: [
      { type: "human", id: directChat.participants[1].id },
      { type: "agent", id: ids.agent }
    ]
  });

  await page
    .getByRole("textbox", { name: "Write a message" })
    .fill("**Release ready**");
  await page.getByRole("button", { name: "Mention" }).click();
  await page
    .getByText("Mention a participant")
    .locator("..")
    .getByRole("button", { name: /Build Agent.*Agent/ })
    .click();
  await page.getByRole("button", { name: "Attach document" }).click();
  await page
    .getByRole("button", { name: "release-notes.md", exact: true })
    .click();
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Release ready", { exact: true })).toBeVisible();
  await expect(page.getByText("@Build Agent", { exact: true })).toBeVisible();
  await expect(
    page
      .getByLabel("Message history")
      .getByText("release-notes.md", { exact: true })
  ).toBeVisible();
  expect(state.getLastSentMessage()).toEqual({
    body_markdown: "**Release ready** @Build_Agent ",
    mentions: [{ type: "agent", id: ids.agent }],
    document_ids: ["00000000-0000-4000-8000-000000000029"]
  });
  if (testInfo.project.name === "macos-default")
    await page.screenshot({
      path: testInfo.outputPath("orchestrat-messaging-group.png"),
      animations: "disabled"
    });

  await page
    .getByLabel("Conversations")
    .getByText("Build Agent", { exact: true })
    .click();
  await expect(page.getByText("Read-only observer")).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Write a message" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Join conversation" })
  ).toHaveCount(0);
  if (testInfo.project.name === "macos-default")
    await page.screenshot({
      path: testInfo.outputPath("orchestrat-messaging-observer.png"),
      animations: "disabled"
    });
  await page
    .getByLabel("Conversations")
    .getByRole("button", { name: /Agent deployment/ })
    .click();
  await page.getByRole("button", { name: "Join conversation" }).click();
  await expect(
    page.getByRole("textbox", { name: "Write a message" })
  ).toBeVisible();
  await expect(
    page
      .getByLabel("Conversations")
      .getByRole("button", { name: /Agent deployment/ })
  ).toBeVisible();
  expect(state.getChat(joinableGroup.id)).toMatchObject({
    has_human: true,
    is_participant: true,
    can_join: false
  });
  await expect.poll(() => Boolean(state.getSocket(ids.beta))).toBe(true);
  state.getSocket(ids.beta)!.send(
    JSON.stringify({
      project_id: ids.beta,
      sequence: 1,
      event_type: "chat.message_created",
      entity_type: "chat",
      entity_id: betaChat.id,
      actor: { type: "agent", id: ids.agent },
      mentions: [{ type: "human", id: ids.user }]
    })
  );
  await expect(page.getByLabel("New message notifications")).toContainText(
    "Mentioned you"
  );
  await page.getByRole("button", { name: "Open chat" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/projects/${ids.beta}/messages\\?chat=${betaChat.id}$`)
  );
  await expect(
    page.getByRole("textbox", { name: "Write a message" })
  ).toBeVisible();
  await expect(page.getByText("Cross-project update")).toBeVisible();
  await expect(
    page.getByText(
      "Some messages could not be synchronized. Retry to load the complete conversation."
    )
  ).toHaveCount(0);
  expect(
    await page
      .locator("#main-content")
      .evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  if (testInfo.project.name === "macos-default")
    await page.screenshot({
      path: testInfo.outputPath("orchestrat-messaging-desktop.png"),
      animations: "disabled"
    });
  expect(errors).toEqual([]);
});

test("@phone messaging switches between the conversation list and chat pane without overflow", async ({
  page
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "phone-project",
    "The chat-pane back control is phone-only."
  );
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const chat = {
    id: "00000000-0000-4000-8000-000000000034",
    project_id: ids.alpha,
    kind: "direct",
    name: null,
    has_human: true,
    creator: { type: "human", id: ids.user },
    participants: [
      { type: "human", id: ids.user, name: "E2E User", avatar_url: null },
      {
        type: "human",
        id: "00000000-0000-4000-8000-000000000027",
        name: "Alice",
        avatar_url: null
      }
    ],
    is_participant: true,
    can_manage: false,
    can_join: false,
    last_sequence: 1,
    last_read_sequence: 1,
    unread_count: 0,
    mention_count: 0,
    created_at: now,
    updated_at: now
  };
  await seed(page);
  await mockHierarchy(page, {
    ...populatedState(),
    chats: [chat],
    messages: {
      [chat.id]: [
        {
          id: "00000000-0000-4000-8000-000000000035",
          chat_id: chat.id,
          project_id: ids.alpha,
          sequence: 1,
          author: { type: "human", id: chat.participants[1].id, name: "Alice" },
          body_markdown: "Mobile history",
          mentions: [],
          documents: [],
          created_at: now
        }
      ]
    }
  });
  await page.goto(`/projects/${ids.alpha}/messages?chat=${chat.id}`);
  await expect(
    page.getByRole("textbox", { name: "Write a message" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Back to chats" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.alpha}/messages$`));
  await page
    .getByLabel("Conversations")
    .getByRole("button", { name: /Alice/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`chat=${chat.id}$`));
  await expect(
    page.getByRole("textbox", { name: "Write a message" })
  ).toBeVisible();
  expect(
    await page
      .locator("#main-content")
      .evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("orchestrat-messaging-phone.png"),
    animations: "disabled"
  });
  expect(errors).toEqual([]);
});
