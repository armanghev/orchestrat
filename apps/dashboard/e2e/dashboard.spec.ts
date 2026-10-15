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
  attention?: Record<string, unknown>;
  taskAttention?: Array<Record<string, unknown>>;
  agentAttention?: Array<Record<string, unknown>>;
  /** Branches per project id; each project otherwise has only `main`. */
  branches?: Record<string, Array<Record<string, unknown>>>;
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
function defaultBranch(projectId: string) {
  return {
    id: `${projectId.slice(0, -4)}b000`,
    project_id: projectId,
    name: "main",
    is_default: true,
    name_source: "fallback",
    created_via: "migration",
    created_by: null,
    onboarding_state: "completed",
    onboarding_choice: null,
    archived_at: null,
    archived_reason: null,
    provider: null,
    open_decision_count: 0,
    created_at: now,
    updated_at: now
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
  const handoffs: Array<{
    body: Record<string, unknown>;
    idempotencyKey: string | undefined;
  }> = [];
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
      const body = route.request().postDataJSON() as {
        name: string;
        slug: string;
      };
      const created = {
        ...organization(ids.organization, body.name),
        slug: body.slug
      };
      state.organizations = [created];
      return route.fulfill({ json: created });
    }
    const summariesMatch = path.match(
      /^\/api\/v1\/organizations\/([^/]+)\/project-summaries$/
    );
    if (summariesMatch && method === "GET") {
      const organizationId = summariesMatch[1];
      if (state.failingOrganizationId === organizationId)
        return route.abort("failed");
      return route.fulfill({
        json: {
          projects: (state.projects[organizationId] ?? []).map((item) => {
            const name = String(item.name ?? "Project");
            const prefix = name.replace(/[^a-z0-9]/gi, "").slice(0, 3);
            return {
              role: "owner",
              ...item,
              task_key_prefix:
                prefix.length >= 2 ? prefix.toUpperCase() : "PRJ",
              default_branch_name: "main",
              member_count: 1,
              open_task_count: 0,
              last_activity_at: item.updated_at ?? now,
              repository: null
            };
          })
        }
      });
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
    const branches = path.match(/^\/api\/v1\/projects\/([^/]+)\/branches$/);
    if (branches && method === "GET")
      return route.fulfill({
        json: {
          branches: state.branches?.[branches[1]!] ?? [
            defaultBranch(branches[1]!)
          ]
        }
      });
    if (/^\/api\/v1\/projects\/[^/]+\/repository$/.test(path))
      return route.fulfill({
        json: {
          repository: null,
          providers: ["github", "gitlab", "origin"].map((provider) => ({
            provider,
            configured: false,
            unavailable_reason: "Not set up on this server."
          }))
        }
      });
    if (/^\/api\/v1\/projects\/[^/]+\/inbox$/.test(path))
      return route.fulfill({ json: { unread_chats: [] } });
    if (/^\/api\/v1\/projects\/[^/]+\/attention$/.test(path))
      return route.fulfill({
        json: state.attention ?? attentionSummary()
      });
    if (/^\/api\/v1\/projects\/[^/]+\/attention\/tasks$/.test(path))
      return route.fulfill({ json: { tasks: state.taskAttention ?? [] } });
    if (/^\/api\/v1\/projects\/[^/]+\/attention\/agents$/.test(path))
      return route.fulfill({ json: { agents: state.agentAttention ?? [] } });
    const handoff = path.match(/^\/api\/v1\/projects\/([^/]+)\/handoffs$/);
    if (handoff && method === "POST") {
      const body = route.request().postDataJSON() as {
        to: { type: "human" | "agent"; id: string };
        body_markdown: string;
        task_id?: string;
      };
      handoffs.push({
        body,
        idempotencyKey: route.request().headers()["idempotency-key"]
      });
      const recipient = (state.messageCandidates ?? []).find(
        (candidate) =>
          candidate.type === body.to.type && candidate.id === body.to.id
      );
      return route.fulfill({
        status: 201,
        json: {
          handoff: {
            id: "00000000-0000-4000-8000-000000000060",
            chat_id: "00000000-0000-4000-8000-000000000061",
            message_id: "00000000-0000-4000-8000-000000000062",
            message_sequence: 1,
            from: { type: "human", id: ids.user, name: "E2E User" },
            to: { ...body.to, name: recipient?.name ?? "Agent" },
            task: null,
            chain_id: "00000000-0000-4000-8000-000000000063",
            hop: 0,
            created_at: now
          }
        }
      });
    }
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
    if (path === "/api/v1/repository/providers")
      return route.fulfill({
        json: {
          providers: [
            {
              provider: "github",
              configured: false,
              unavailable_reason: "GitHub isn’t set up on this server."
            }
          ]
        }
      });
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });
  return {
    getChat: (chatId: string) => state.chats?.find(({ id }) => id === chatId),
    getLastCreatedChat: () => lastCreatedChat,
    getLastSentMessage: () => lastSentMessage,
    getHandoffs: () => handoffs,
    getSocket: (projectId: string) => sockets.get(projectId)
  };
}

function attentionSummary(tasks: Array<Record<string, unknown>> = []) {
  return {
    cursor: "0",
    branch_id: null,
    unread_chats: [],
    tasks,
    handoffs: [],
    blockers_resolved: [],
    truncated: false
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
// Sheets and dialogs fade in; contrast checks must wait for the final colors.
async function settle(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((animation) => animation.playState !== "running")
  );
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

test("creates organization and project sequentially @phone", async ({
  page
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await seed(page);
  await mockHierarchy(page, {
    organizations: [],
    projects: {}
  });
  await page.goto("/setup");
  await expect(
    page.getByRole("heading", { name: "Create your organization" })
  ).toBeVisible();
  await page.getByLabel("Organization name").fill("Café Studio");
  await expect(page.getByLabel("Organization slug")).toHaveValue("cafe-studio");
  await expect(page.getByText("org/", { exact: true })).toBeVisible();
  await page.getByLabel("Organization slug").fill("acme-studio");
  await page.getByLabel("Organization name").fill("Acme");
  await expect(page.getByLabel("Organization slug")).toHaveValue("acme-studio");
  await expectNoAxe(page);
  await page.screenshot({
    path: testInfo.outputPath("create-organization.png")
  });
  expect(
    await page
      .locator("main")
      .evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  expect(errors).toEqual([]);
  const [request] = await Promise.all([
    page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/v1/organizations"
    ),
    page.getByRole("button", { name: "Create organization" }).click()
  ]);
  expect(request.postDataJSON()).toEqual({ name: "Acme", slug: "acme-studio" });
  await expect(page).toHaveURL(
    new RegExp(`/organizations/${ids.organization}/projects/new$`)
  );
  await page.getByLabel("Project name").fill("Alpha");
  await page.getByRole("button", { name: "Create empty project" }).click();
  await expect(page.locator('[data-slot="top-toolbar-page"]')).toHaveText(
    "Overview"
  );
  await expectNoAxe(page);
});

test("organization home lists projects and links back from a project", async ({
  page
}) => {
  await seed(page);
  await mockHierarchy(page, populatedState());
  await page.goto(`/projects/${ids.alpha}/overview`);
  await page.getByRole("button", { name: /^Organization: / }).click();
  await expect(page).toHaveURL(
    new RegExp(`/organizations/${ids.organization}$`)
  );
  await expect(
    page.getByRole("complementary", { name: "Organization navigation" })
  ).toBeVisible();
  await expect(page.locator('[data-slot="top-toolbar-page"]')).toHaveText(
    "Projects"
  );
  await page.getByRole("link", { name: /Beta/ }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${ids.beta}/overview$`));
  await page.goto(`/organizations/${ids.organization}`);
  await expect(page.getByRole("link", { name: /Alpha/ })).toBeVisible();
  await settle(page);
  await expectNoAxe(page);

  await page.goto(`/organizations/${ids.organization}/members`);
  await expect(page.locator('[data-slot="top-toolbar-page"]')).toHaveText(
    "Members"
  );
  await expect(page.getByRole("table")).toBeVisible();
  await settle(page);
  await expectNoAxe(page);

  await page.goto(`/organizations/${ids.organization}/settings`);
  await expect(page.getByLabel("Name")).toBeVisible();
  await settle(page);
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
      sequence: 1,
      mentions: [],
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
          sequence: comments.length + 1,
          mentions: [],
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

test("@phone task attention shows unread badges, a New divider, and a watch toggle in both themes", async ({
  page
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  const task = {
    id: ids.task,
    project_id: ids.alpha,
    key: "ALPHA-1",
    title: "Review attention",
    description: null,
    priority: "medium",
    status: "in_progress",
    position: 0,
    version: 1,
    created_by: { type: "human", id: ids.user },
    created_by_user_id: ids.user,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    comment_count: 3,
    unresolved_blocker_count: 0
  };
  const comment = (sequence: number, body: string) => ({
    id: `00000000-0000-4000-8000-0000000001${String(sequence).padStart(2, "0")}`,
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
    body_markdown: body,
    sequence,
    mentions:
      sequence === 3 ? [{ type: "human", id: ids.user, name: "E2E User" }] : [],
    created_at: now
  });
  const comments = [
    comment(1, "Earlier context."),
    comment(2, "Tests are green."),
    comment(3, "Can you review?")
  ];
  const attention = { watching: true, lastRead: 1, unread: 2, mentions: 1 };
  const state: HierarchyState = { ...populatedState(), tasks: [task] };
  const sync = () => {
    state.taskAttention = [
      {
        task_id: ids.task,
        watching: attention.watching,
        unread_count: attention.unread,
        mention_count: attention.mentions,
        claim: null,
        block: null
      }
    ];
    state.attention = attentionSummary(
      attention.watching && attention.unread
        ? [
            {
              task_id: ids.task,
              key: task.key,
              title: task.title,
              status: task.status,
              watching: true,
              claimed_by_you: false,
              unread_count: attention.unread,
              mention_count: attention.mentions,
              blocking_unread_count: 0,
              last_read_sequence: attention.lastRead,
              latest_sequence: 3,
              unread: []
            }
          ]
        : []
    );
  };
  sync();
  const reads: number[] = [];
  const watches: boolean[] = [];
  await seed(page);
  await mockHierarchy(page, state);
  await page.route(
    `https://api.orchestrat.test/api/v1/tasks/${ids.task}**`,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      const watchState = () => ({
        task_id: ids.task,
        state: attention.watching ? "watching" : "muted",
        reason: "explicit",
        last_read_sequence: attention.lastRead
      });
      if (path.endsWith("/comments/read")) {
        const body = route.request().postDataJSON() as {
          through_sequence: number;
        };
        reads.push(body.through_sequence);
        Object.assign(attention, {
          lastRead: body.through_sequence,
          unread: 0,
          mentions: 0
        });
        sync();
        return route.fulfill({ json: watchState() });
      }
      if (path.endsWith("/watch")) {
        const body = route.request().postDataJSON() as { watching: boolean };
        watches.push(body.watching);
        attention.watching = body.watching;
        sync();
        return route.fulfill({ json: watchState() });
      }
      if (path.endsWith("/comments"))
        return route.fulfill({ json: { comments, next_cursor: null } });
      if (path.endsWith("/dependencies"))
        return route.fulfill({ json: { depends_on: [], blocks: [] } });
      return route.fulfill({ json: task });
    }
  );
  await page.goto(`/projects/${ids.alpha}/tasks`);
  await expect(
    page.getByRole("img", { name: "2 unread comments, 1 mention" })
  ).toBeVisible();
  const phone = (page.viewportSize()?.width ?? 1280) < 768;
  if (phone)
    await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("img", { name: "2 unread task comments, 1 mention" })
  ).toBeVisible();
  // Let the mobile sidebar sheet finish its entrance before checking contrast.
  await settle(page);
  await expectNoAxe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await settle(page);
  await expectNoAxe(page);
  if (phone) {
    await page.getByRole("button", { name: /^Tasks/ }).click();
    await expect(
      page.getByRole("dialog", { name: "Sidebar" })
    ).not.toBeVisible();
  }
  await page.getByRole("button", { name: "ALPHA-1 Review attention" }).click();
  const sheet = page.getByRole("dialog", { name: "Task details" });
  const divider = sheet
    .getByRole("list", { name: "Task comments" })
    .getByText("New", { exact: true });
  await divider.scrollIntoViewIfNeeded();
  await expect(divider).toBeVisible();
  await expect(
    sheet.getByRole("listitem").filter({ hasText: "Tests are green." })
  ).toBeVisible();
  await expect.poll(() => reads).toEqual([3]);
  // The divider stays where the unread comments started after the read.
  await expect(divider).toBeVisible();
  await expectNoAxe(page);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await settle(page);
  await expectNoAxe(page);
  const toggle = sheet.getByRole("button", { name: "Watch task" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(watches).toEqual([false]);
  expect(
    await page
      .locator("#main-content")
      .evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  await expectNoAxe(page);
});

test("@phone blocked tasks show the card line and callout, and Resolve blocker confirms in both themes", async ({
  page
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  const blockingTaskId = "00000000-0000-4000-8000-000000000012";
  const baseTask = {
    project_id: ids.alpha,
    description: null,
    priority: "medium",
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
  let task: Record<string, unknown> = {
    ...baseTask,
    id: ids.task,
    key: "ALPHA-1",
    title: "Wire the API",
    status: "blocked"
  };
  const blocking = {
    ...baseTask,
    id: blockingTaskId,
    key: "ALPHA-2",
    title: "Ship the contract",
    status: "in_progress",
    position: 1
  };
  const block = {
    id: "00000000-0000-4000-8000-000000000040",
    task_id: ids.task,
    reason: "Waiting for the handoff schema to land.",
    blocking_task: {
      id: blockingTaskId,
      key: "ALPHA-2",
      title: blocking.title
    },
    blocked_on: { type: "agent", id: ids.agent, name: "Codex" },
    created_by: { type: "agent", id: ids.agent, name: "Codex" },
    created_at: new Date(Date.now() - 12 * 60_000).toISOString(),
    resolved_at: null,
    resolution: null
  };
  const state: HierarchyState = {
    ...populatedState(),
    tasks: [task, blocking],
    messageCandidates: [
      { type: "agent", id: ids.agent, name: "Codex", avatar_url: null }
    ],
    taskAttention: [
      {
        task_id: ids.task,
        watching: false,
        unread_count: 0,
        mention_count: 0,
        claim: null,
        block
      }
    ]
  };
  const resolves: unknown[] = [];
  await seed(page);
  await mockHierarchy(page, state);
  await page.route(
    `https://api.orchestrat.test/api/v1/tasks/${ids.task}**`,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/block/resolve")) {
        resolves.push(route.request().postDataJSON());
        task = { ...task, status: "ready", version: 2 };
        state.tasks = [task, blocking];
        state.taskAttention = [];
        return route.fulfill({
          json: {
            ...block,
            resolved_at: now,
            resolution: "resolved_by_human"
          }
        });
      }
      if (path.endsWith("/comments"))
        return route.fulfill({ json: { comments: [], next_cursor: null } });
      if (path.endsWith("/dependencies"))
        return route.fulfill({ json: { depends_on: [], blocks: [] } });
      return route.fulfill({ json: task });
    }
  );
  await page.goto(`/projects/${ids.alpha}/tasks`);
  const cardLine = page.getByText("Blocked by ALPHA-2 · waiting on Codex");
  await expect(cardLine).toBeVisible();
  await settle(page);
  await expectNoAxe(page);
  await page.getByRole("tab", { name: "List" }).click();
  await expect(
    page.getByRole("table").getByText("Blocked by ALPHA-2 · waiting on Codex")
  ).toBeVisible();
  await page.getByRole("tab", { name: "Board" }).click();
  await page.getByRole("button", { name: "ALPHA-1 Wire the API" }).click();
  const sheet = page.getByRole("dialog", { name: "Task details" });
  const callout = sheet.getByRole("region", { name: "Blocked" });
  await expect(
    callout.getByText("Waiting for the handoff schema to land.")
  ).toBeVisible();
  await expect(
    callout.getByRole("link", { name: "ALPHA-2 Ship the contract" })
  ).toBeVisible();
  await expect(callout.getByText("Codex (agent)")).toBeVisible();
  await expect(callout.getByText("12 min ago")).toBeVisible();
  await settle(page);
  await expectNoAxe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await settle(page);
  await expectNoAxe(page);
  // Ping from the sheet prefills the task and the participant it waits on.
  const ping = sheet.getByRole("button", { name: "Ping" });
  await ping.click();
  const pingDialog = page.getByRole("dialog", { name: "Ping" });
  await expect(pingDialog).toContainText("Task ALPHA-1 · Wire the API");
  await expect(pingDialog.getByLabel("Recipient")).toHaveValue(
    `agent:${ids.agent}`
  );
  await settle(page);
  await expectNoAxe(page);
  await page.keyboard.press("Escape");
  await expect(pingDialog).not.toBeVisible();
  await expect(sheet).toBeVisible();
  await expect(ping).toBeFocused();
  await callout.getByRole("button", { name: "Resolve blocker" }).click();
  const confirm = page.getByRole("dialog", { name: "Resolve blocker?" });
  await expect(confirm).toContainText("ALPHA-1 returns to In progress");
  await settle(page);
  await expectNoAxe(page);
  await page.keyboard.press("Escape");
  await expect(confirm).not.toBeVisible();
  await expect(
    callout.getByRole("button", { name: "Resolve blocker" })
  ).toBeFocused();
  expect(resolves).toEqual([]);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await callout.getByRole("button", { name: "Resolve blocker" }).click();
  await confirm.getByRole("button", { name: "Resolve blocker" }).click();
  await expect(confirm).not.toBeVisible();
  expect(resolves).toEqual([{}]);
  await expect(callout).not.toBeVisible();
  await expect(
    sheet.getByRole("heading", { name: "Wire the API" })
  ).toBeFocused();
  await expect(cardLine).toHaveCount(0);
  expect(
    await page
      .locator("#main-content")
      .evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  await settle(page);
  await expectNoAxe(page);
});

test("the task board scrolls sideways and moves a dragged card to its column", async ({
  page
}) => {
  let task: Record<string, unknown> = {
    id: ids.task,
    project_id: ids.alpha,
    key: "ALPHA-1",
    title: "Wire the API",
    description: null,
    priority: "medium",
    status: "backlog",
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
  const state: HierarchyState = { ...populatedState(), tasks: [task] };
  const moves: unknown[] = [];
  await seed(page);
  await mockHierarchy(page, state);
  await page.route(
    `https://api.orchestrat.test/api/v1/tasks/${ids.task}/move`,
    async (route) => {
      moves.push(route.request().postDataJSON());
      task = { ...task, status: "ready", version: 2 };
      state.tasks = [task];
      return route.fulfill({ json: task });
    }
  );
  await page.goto(`/projects/${ids.alpha}/tasks`);
  const card = page.getByRole("button", { name: "ALPHA-1 Wire the API" });
  await expect(card).toBeVisible();
  // Eight status columns sit in one row that scrolls, not the page.
  const board = page.getByTestId("task-board");
  expect(
    await board.evaluate((element) => element.scrollWidth > element.clientWidth)
  ).toBe(true);
  expect(
    await page
      .locator("#main-content")
      .evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  const tops = await board
    .locator(":scope > section")
    .evaluateAll((columns) =>
      columns.map((column) => column.getBoundingClientRect().top)
    );
  expect(new Set(tops).size).toBe(1);
  const ready = page.getByRole("region", { name: "ready" });
  await card.dragTo(ready);
  await expect(
    ready.getByRole("button", { name: "ALPHA-1 Wire the API" })
  ).toBeVisible();
  expect(moves).toEqual([{ status: "ready", expected_version: 1 }]);
  await settle(page);
  await expectNoAxe(page);
});

test("@phone Agents page shows attention lines and a keyboard Ping flow in both themes", async ({
  page
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  const claude = "00000000-0000-4000-8000-000000000013";
  const agent = (id: string, name: string) => ({
    id,
    project_id: ids.alpha,
    name,
    status: "active",
    created_at: now,
    updated_at: now,
    revoked_at: null
  });
  const state: HierarchyState = {
    ...populatedState(),
    agents: [agent(claude, "claude-code"), agent(ids.agent, "codex")],
    messageCandidates: [
      { type: "agent", id: claude, name: "claude-code", avatar_url: null },
      { type: "agent", id: ids.agent, name: "codex", avatar_url: null }
    ],
    agentAttention: [
      {
        agent_id: ids.agent,
        waiting_since: null,
        pending_directed_count: 0,
        open_block: null,
        current_task: {
          id: ids.task,
          key: "ALPHA-3",
          title: "Wire the API",
          status: "in_progress"
        }
      },
      {
        agent_id: claude,
        waiting_since: now,
        pending_directed_count: 2,
        open_block: {
          task: {
            id: "00000000-0000-4000-8000-000000000012",
            key: "ALPHA-4",
            title: "Ship the contract"
          },
          reason: "Waiting on codex"
        },
        current_task: null
      }
    ]
  };
  await seed(page);
  const mock = await mockHierarchy(page, state);
  await page.goto(`/projects/${ids.alpha}/agents`);
  await expect(
    page.getByText("Working on ALPHA-3 · in progress")
  ).toBeVisible();
  await expect(
    page.getByText("Blocked on ALPHA-4 · waiting for updates · 2 pending items")
  ).toBeVisible();
  await expectNoAxe(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await settle(page);
  await expectNoAxe(page);
  const trigger = page.getByRole("button", { name: "Ping codex" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Ping" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Recipient")).toHaveValue(
    `agent:${ids.agent}`
  );
  // The recipient is preset, so focus starts in the message.
  await expect(dialog.getByLabel("Message")).toBeFocused();
  await settle(page);
  await expectNoAxe(page);
  await page.keyboard.type("Can you pick up ALPHA-4 next?");
  // WebKit's Tab skips buttons unless Alt is held, like Safari's default.
  await page.keyboard.press("Alt+Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Alt+Tab");
  await expect(dialog.getByRole("button", { name: "Send ping" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.getByText("Ping sent to codex")).toBeVisible();
  const [sent] = mock.getHandoffs();
  expect(mock.getHandoffs()).toHaveLength(1);
  expect(sent?.body).toEqual({
    to: { type: "agent", id: ids.agent },
    body_markdown: "Can you pick up ALPHA-4 next?"
  });
  expect(sent?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByRole("button", { name: "Ping claude-code" }).click();
  await expect(dialog.getByLabel("Recipient")).toHaveValue(`agent:${claude}`);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ping claude-code" })
  ).toBeFocused();
  expect(
    await page
      .locator("#main-content")
      .evaluate((element) => element.scrollWidth <= element.clientWidth)
  ).toBe(true);
  await settle(page);
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
  // Organization, project and branch menus, the appearance menu, plus the
  // trigger, separator and breadcrumb (docs/project-branches.md §11.2).
  expect(centers).toHaveLength(7);
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
  await settle(page);
  await expectNoAxe(page);
  await page.getByText("Light", { exact: true }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await settle(page);
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
