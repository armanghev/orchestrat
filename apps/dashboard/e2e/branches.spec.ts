import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Project branches end to end against a mocked API (docs/project-branches.md
// §11, §13.4). Tests tagged @phone also run on the phone project.

// Each flow scans with axe in both themes, which takes a while on CI's
// Linux WebKit.
test.describe.configure({ timeout: 90_000 });

const ids = {
  organization: "00000000-0000-4000-8000-000000000001",
  project: "00000000-0000-4000-8000-000000000004",
  user: "00000000-0000-4000-8000-000000000007",
  agent: "00000000-0000-4000-8000-000000000009",
  main: "00000000-0000-4000-8000-00000000b001",
  checkout: "00000000-0000-4000-8000-00000000b002",
  old: "00000000-0000-4000-8000-00000000b003",
  created: "00000000-0000-4000-8000-00000000b004"
} as const;
const now = "2026-09-30T00:00:00.000Z";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const authorizationId = "ra_e2eabcdefghijklmnopqrstu";

type Row = Record<string, unknown>;
type Branch = Row & {
  id: string;
  name: string;
  is_default: boolean;
  archived_at: string | null;
  onboarding_state: string;
  open_decision_count: number;
};

function branchRow(id: string, name: string, extra: Row = {}): Branch {
  return {
    id,
    project_id: ids.project,
    name,
    is_default: false,
    name_source: "user",
    created_via: "dashboard",
    created_by: null,
    onboarding_state: "completed",
    onboarding_choice: null,
    archived_at: null,
    archived_reason: null,
    provider: null,
    open_decision_count: 0,
    created_at: now,
    updated_at: now,
    ...extra
  } as Branch;
}

function taskRow(n: number, branchId: string, title: string, extra: Row = {}) {
  return {
    id: uuid(n),
    project_id: ids.project,
    branch_id: branchId,
    key: `DASH-${n}`,
    title,
    description: null,
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
    unresolved_blocker_count: 0,
    ...extra
  };
}

function documentRow(n: number, branchId: string, path: string) {
  return {
    id: uuid(n),
    project_id: ids.project,
    branch_id: branchId,
    path,
    current_revision: 1,
    archived_at: null,
    created_by: { type: "human", id: ids.user },
    created_at: now,
    updated_at: now
  };
}

function chatRow(n: number, branchId: string, name: string) {
  return {
    id: uuid(n),
    project_id: ids.project,
    branch_id: branchId,
    kind: "group",
    name,
    has_human: true,
    creator: { type: "human", id: ids.user },
    participants: [
      { type: "human", id: ids.user, name: "E2E User", avatar_url: null },
      { type: "agent", id: ids.agent, name: "codex", avatar_url: null }
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
}

function previewItem(
  n: number,
  itemType: "task" | "document" | "chat",
  label: string,
  extra: Row = {}
) {
  return {
    item_type: itemType,
    lineage_key: uuid(n),
    source_id: uuid(n),
    target_id: null,
    outcome: "copy",
    reason: null,
    fields: [],
    required_by: [],
    label,
    task_key: itemType === "task" ? label.split(" ")[0] : null,
    audience: null,
    source_values: null,
    target_values: null,
    ...extra
  };
}

type Selection = { tasks: string[]; documents: string[]; chats: string[] };

async function seed(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("orchestrat.e2e.seeded")) return;
    localStorage.clear();
    localStorage.setItem("orchestrat.e2e.auth", "signedIn");
    sessionStorage.setItem("orchestrat.e2e.seeded", "true");
  });
}

// Sheets and dialogs fade in; contrast checks wait for the final colors.
async function settle(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((animation) => animation.playState !== "running")
  );
}

/**
 * Zero axe violations in the light and the dark theme. An open dropdown
 * menu traps focus and hides the page behind it, which axe reports as
 * focusable hidden content, so open menus are checked on their own.
 */
async function expectNoAxe(page: Page, include?: string) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    // The theme class lands first; its color transitions start after.
    if (colorScheme === "dark")
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
    );
    await settle(page);
    const builder = new AxeBuilder({ page });
    if (include) builder.include(include);
    expect((await builder.analyze()).violations).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
  await settle(page);
}

/** The toolbar's Search (the sidebar has its own). */
const openSearch = (page: Page) =>
  page
    .locator('[data-slot="top-toolbar"]')
    .getByRole("button", { name: "Search" })
    .click();

async function mockBranches(
  page: Page,
  options: { role?: "owner" | "member"; importStaleOnce?: boolean } = {}
) {
  const state = {
    role: options.role ?? "owner",
    branches: [
      branchRow(ids.main, "main", {
        is_default: true,
        name_source: "fallback",
        created_via: "migration"
      }),
      branchRow(ids.checkout, "feat/checkout", {
        name_source: "cli",
        created_via: "cli",
        updated_at: "2026-09-29T00:00:00.000Z"
      }),
      branchRow(ids.old, "feat/old", {
        name_source: "provider",
        created_via: "provider",
        archived_at: "2026-09-27T12:00:00.000Z",
        archived_reason: "provider_deleted",
        provider: { provider: "github", state: "missing", head_sha: null }
      })
    ] as Branch[],
    tasks: {
      [ids.main]: [taskRow(1, ids.main, "Schema"), taskRow(2, ids.main, "API")],
      [ids.checkout]: [taskRow(7, ids.checkout, "Checkout copy")],
      [ids.old]: [taskRow(8, ids.old, "Old experiment")]
    } as Record<string, Row[]>,
    documents: {
      [ids.main]: [documentRow(21, ids.main, "README.md")],
      [ids.checkout]: [documentRow(22, ids.checkout, "checkout.md")],
      [ids.old]: [documentRow(23, ids.old, "notes.md")]
    } as Record<string, Row[]>,
    chats: {
      [ids.main]: [chatRow(31, ids.main, "Release")],
      [ids.checkout]: [chatRow(32, ids.checkout, "Checkout review")],
      [ids.old]: [chatRow(33, ids.old, "Old thread")]
    } as Record<string, Row[]>,
    decisions: [] as Row[],
    runs: [] as Row[],
    repository: null as Row | null,
    importStaleOnce: options.importStaleOnce ?? false,
    importVersion: 1,
    documentSaveFails: false,
    applied: [] as Row[],
    resolved: [] as string[],
    seen: [] as string[]
  };
  const branchById = (id: string) =>
    state.branches.find((branch) => branch.id === id)!;
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, json: body });
  const importItems = () => [
    previewItem(1, "task", "DASH-1 Schema", { required_by: [uuid(2)] }),
    previewItem(2, "task", "DASH-2 API"),
    previewItem(21, "document", "README.md", {
      target_id: uuid(24),
      outcome: "conflict",
      reason: "added_on_both",
      fields: ["body"],
      source_values: { body: "Main's readme" },
      target_values: {
        body: state.importVersion === 1 ? "Agent notes" : "Agent notes, edited"
      }
    }),
    previewItem(31, "chat", "Release", {
      outcome: "skipped",
      reason: "audience_would_widen",
      audience: [
        { type: "human", id: ids.user, name: "E2E User" },
        { type: "agent", id: ids.agent, name: "codex" }
      ]
    })
  ];
  const importPreview = (selection: Selection | "all") => {
    const all = importItems();
    const chosen =
      selection === "all"
        ? all
        : all.filter((item) =>
            item.item_type === "task"
              ? selection.tasks.includes(item.lineage_key) ||
                (item.required_by as string[]).some((dependent) =>
                  selection.tasks.includes(dependent)
                )
              : item.item_type === "document"
                ? selection.documents.includes(item.lineage_key)
                : selection.chats.includes(item.lineage_key)
          );
    return {
      fingerprint: String(state.importVersion).repeat(64),
      kind: "import",
      source_branch_id: ids.main,
      target_branch_id: ids.created,
      items: chosen,
      counts: {}
    };
  };
  const mergePreview = () => ({
    fingerprint: "c".repeat(64),
    kind: "merge",
    source_branch_id: ids.checkout,
    target_branch_id: ids.main,
    items: [
      previewItem(7, "task", "DASH-7 Checkout copy", {
        target_id: uuid(9),
        outcome: "conflict",
        reason: "changed_on_both",
        fields: ["title"],
        source_values: { title: "Checkout copy" },
        target_values: { title: "Checkout text" }
      }),
      previewItem(22, "document", "checkout.md")
    ],
    counts: { "document.copy": 1, "task.conflict": 1 }
  });
  const decisionRow = () => ({
    id: uuid(401),
    project_id: ids.project,
    run_id: uuid(301),
    source_branch_id: ids.checkout,
    target_branch_id: ids.main,
    item_type: "task",
    lineage_key: uuid(7),
    source_item_id: uuid(7),
    target_item_id: uuid(9),
    label: "DASH-7 Checkout copy",
    reason: "changed_on_both",
    fields: ["title"],
    source_values: { title: "Checkout copy" },
    target_values: { title: "Checkout text" },
    status: "open",
    resolved_by_user_id: null,
    resolved_at: null,
    created_at: now
  });
  const run = (body: Row, extra: Row = {}) => ({
    id: uuid(301 + state.runs.length),
    project_id: ids.project,
    source_branch_id: body.source_branch_id,
    target_branch_id: body.target_branch_id,
    kind: body.kind,
    trigger: "dashboard",
    status: "applied",
    skip_reason: null,
    provider: null,
    counts: {},
    skipped: [],
    decision_count: 0,
    created_by: { type: "human", id: ids.user },
    created_at: now,
    applied_at: now,
    ...extra
  });

  await page.routeWebSocket(
    "wss://api.orchestrat.test/api/v1/realtime/**",
    () => undefined
  );
  await page.route("https://api.orchestrat.test/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/api/v1", "");
    const method = route.request().method();
    const body = () => (route.request().postDataJSON() ?? {}) as Row;
    const branchId = url.searchParams.get("branch_id") ?? ids.main;
    const projectPath = `/projects/${ids.project}`;
    if (path.startsWith(projectPath))
      state.seen.push(
        `${path.slice(projectPath.length) || "/"}:${url.searchParams.get("all_branches") ? "all" : branchId}`
      );
    if (path === "/organizations")
      return json(route, {
        organizations: [
          {
            id: ids.organization,
            name: "Acme",
            slug: "acme",
            role: state.role,
            created_at: now,
            updated_at: now
          }
        ]
      });
    if (path === `/organizations/${ids.organization}/projects`)
      return json(route, {
        projects: [
          {
            id: ids.project,
            organization_id: ids.organization,
            name: "Alpha",
            slug: "alpha",
            description: null,
            status: "active",
            role: state.role,
            created_at: now,
            updated_at: now,
            archived_at: null
          }
        ]
      });
    if (path === `/organizations/${ids.organization}/members`)
      return json(route, { members: [] });
    if (path === "/profile")
      return json(route, {
        user_id: ids.user,
        provider: "github",
        username: "e2e_user",
        full_name: "E2E User",
        email: "e2e@example.com",
        avatar_url: null
      });
    if (path === "/realtime/tickets")
      return json(route, { ticket: "e".repeat(32), expires_at: now });
    if (path === `${projectPath}/branches` && method === "GET")
      return json(route, { branches: state.branches });
    if (path === `${projectPath}/branches` && method === "POST") {
      const created = branchRow(ids.created, String(body().name), {
        onboarding_state: "pending",
        updated_at: "2026-09-30T01:00:00.000Z"
      });
      state.branches = [...state.branches, created];
      state.tasks[ids.created] = [taskRow(41, ids.created, "Agent scratch")];
      state.documents[ids.created] = [
        documentRow(24, ids.created, "README.md")
      ];
      state.chats[ids.created] = [];
      return json(route, { branch: created }, 201);
    }
    const branchAction = path.match(
      /^\/projects\/[^/]+\/branches\/([^/]+)\/(default|archive|onboarding)$/
    );
    if (branchAction) {
      const target = branchById(branchAction[1]!);
      if (branchAction[2] === "onboarding")
        target.onboarding_state = "completed";
      return json(route, { branch: target });
    }
    if (path === `${projectPath}/tasks`)
      return json(route, {
        tasks: state.tasks[branchId] ?? [],
        total: (state.tasks[branchId] ?? []).length,
        next_cursor: null
      });
    const taskEntity = path.match(/^\/tasks\/([^/]+)(\/.*)?$/);
    if (taskEntity) {
      const found = Object.values(state.tasks)
        .flat()
        .find((task) => task.id === taskEntity[1]);
      if (taskEntity[2] === "/comments")
        return json(route, { comments: [], next_cursor: null });
      if (taskEntity[2] === "/dependencies")
        return json(route, { depends_on: [], blocks: [] });
      return found ? json(route, found) : json(route, {}, 404);
    }
    if (path === `${projectPath}/documents`)
      return json(route, {
        documents: state.documents[branchId] ?? [],
        folders: [],
        next_cursor: null
      });
    const documentEntity = path.match(/^\/documents\/([^/]+)(\/.*)?$/);
    if (documentEntity) {
      const found = Object.values(state.documents)
        .flat()
        .find((document) => document.id === documentEntity[1]);
      if (documentEntity[2] === "/revisions")
        return json(route, { revisions: [], next_cursor: null });
      if (documentEntity[2] === "/attachments")
        return json(route, { attachments: [] });
      if (method === "PATCH") {
        if (state.documentSaveFails)
          return route.fulfill({ status: 500, body: "" });
        const content = String(body().content);
        return json(route, {
          document: { ...found, current_revision: 2 },
          revision: {
            id: uuid(902),
            document_id: found?.id,
            revision_number: 2,
            content,
            author: { type: "human", id: ids.user },
            created_at: now
          }
        });
      }
      return json(route, {
        document: found,
        revision: {
          id: uuid(901),
          document_id: found?.id,
          revision_number: 1,
          content: `# ${String(found?.path)}\n\nShared notes.`,
          author: { type: "human", id: ids.user },
          created_at: now
        }
      });
    }
    if (path === `${projectPath}/chats`)
      return json(route, { chats: state.chats[branchId] ?? [] });
    if (path === `${projectPath}/inbox`)
      return json(route, {
        unread_chats: url.searchParams.get("all_branches")
          ? [
              {
                chat_id: uuid(32),
                branch_id: ids.checkout,
                unread_count: 2,
                mention_count: 0
              }
            ]
          : []
      });
    const chatEntity = path.match(/^\/chats\/([^/]+)(\/.*)?$/);
    if (chatEntity) {
      if (chatEntity[2] === "/messages")
        return json(route, {
          messages: [],
          has_more: false,
          next_after: null,
          next_before: null
        });
      return json(
        route,
        Object.values(state.chats)
          .flat()
          .find((chat) => chat.id === chatEntity[1]) ?? {}
      );
    }
    if (path === `${projectPath}/message-candidates`)
      return json(route, { candidates: [] });
    if (path === `${projectPath}/presence` || path === `${projectPath}/agents`)
      return json(route, { agents: [] });
    if (path === `${projectPath}/events`)
      return json(route, { events: [], next_cursor: null });
    if (path === `${projectPath}/attention`)
      return json(route, {
        cursor: "0",
        branch_id: null,
        unread_chats: [],
        tasks: [],
        handoffs: [],
        blockers_resolved: [],
        truncated: false
      });
    if (path === `${projectPath}/attention/tasks`)
      return json(route, { tasks: [] });
    if (path === `${projectPath}/attention/agents`)
      return json(route, { agents: [] });
    if (path === `${projectPath}/members`) return json(route, { members: [] });
    if (path === `${projectPath}/invitations`)
      return json(route, { invitations: [] });
    if (path === `${projectPath}/merges/preview`) {
      const request = body();
      return json(route, {
        preview:
          request.kind === "merge"
            ? mergePreview()
            : importPreview(
                (request.selection as Selection & { tasks: unknown }).tasks ===
                  "all"
                  ? "all"
                  : (request.selection as Selection)
              )
      });
    }
    if (path === `${projectPath}/merges` && method === "POST") {
      const request = body();
      state.applied.push(request);
      if (request.kind === "import" && state.importStaleOnce) {
        state.importStaleOnce = false;
        state.importVersion += 1;
        return json(
          route,
          {
            error: {
              code: "BRANCH_PREVIEW_STALE",
              message: "The branches changed since the preview.",
              request_id: "e2e-stale",
              details: {
                preview: importPreview(request.selection as Selection)
              }
            }
          },
          409
        );
      }
      if (request.kind === "merge") {
        const merged = run(request, {
          status: "applied_with_decisions",
          counts: { "document.copy": 1 },
          decision_count: 1
        });
        state.runs.unshift(merged);
        state.decisions = [decisionRow()];
        branchById(ids.main).open_decision_count = 1;
        if (request.archive_source) {
          branchById(ids.checkout).archived_at = now;
          branchById(ids.checkout).archived_reason = "manual";
        }
        return json(route, { run: merged }, 201);
      }
      const imported = run(request, {
        counts: { "task.copy": 2, "document.apply": 1 }
      });
      state.runs.unshift(imported);
      if (request.complete_onboarding)
        branchById(String(request.target_branch_id)).onboarding_state =
          "completed";
      return json(route, { run: imported }, 201);
    }
    if (path === `${projectPath}/merges`)
      return json(route, { runs: state.runs, next_cursor: null });
    if (path === `${projectPath}/decisions`)
      return json(route, {
        decisions: state.decisions.filter(
          (decision) =>
            !url.searchParams.get("branch_id") ||
            decision.target_branch_id === url.searchParams.get("branch_id")
        )
      });
    const resolve = path.match(
      /^\/projects\/[^/]+\/decisions\/([^/]+)\/resolve$/
    );
    if (resolve) {
      state.resolved.push(String(body().choice));
      const settled = {
        ...decisionRow(),
        status:
          body().choice === "use_source" ? "resolved_source" : "resolved_target"
      };
      state.decisions = [];
      branchById(ids.main).open_decision_count = 0;
      return json(route, { decision: settled });
    }
    if (path === `${projectPath}/repository` && method === "GET")
      return json(route, {
        repository: state.repository,
        providers: [
          { provider: "github", configured: true, unavailable_reason: null },
          {
            provider: "gitlab",
            configured: false,
            unavailable_reason: "GitLab isn’t set up on this server."
          },
          { provider: "origin", configured: true, unavailable_reason: null }
        ]
      });
    if (path === `${projectPath}/repository/authorizations`)
      // The "provider" sends the browser straight back to settings.
      return json(route, {
        authorization_id: authorizationId,
        authorize_url: `http://127.0.0.1:8814/projects/${ids.project}/settings?repository_authorization=${authorizationId}`,
        expires_at: "2026-09-30T01:00:00.000Z"
      });
    if (
      path ===
      `${projectPath}/repository/authorizations/${authorizationId}/repositories`
    )
      return json(route, {
        repositories: [
          {
            provider_repository_id: "101",
            full_name: "acme/app",
            default_branch: "trunk",
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
      });
    if (path === `${projectPath}/repository` && method === "POST") {
      branchById(ids.main).name = "trunk";
      branchById(ids.main).name_source = "provider";
      state.repository = {
        id: uuid(501),
        project_id: ids.project,
        provider: "github",
        provider_repository_id: "101",
        full_name: "acme/app",
        url: "https://github.com/acme/app",
        provider_default_branch: "trunk",
        status: "active",
        status_reason: null,
        last_event_at: null,
        last_reconciled_at: now,
        connected_by_user_id: ids.user,
        hook_health: null,
        failed_delivery_count: 0,
        created_at: now,
        updated_at: now
      };
      return json(route, { repository: state.repository }, 201);
    }
    if (path === `${projectPath}/repository/sync`)
      return json(route, { queued: true }, 202);
    if (path === `${projectPath}/repository` && method === "DELETE") {
      state.repository = null;
      return route.fulfill({ status: 204, body: "" });
    }
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });
  return state;
}

const branchMenu = (page: Page, name: string) =>
  page.getByRole("button", { name: `Branch: ${name}` });
const search = (page: Page) => new URL(page.url()).searchParams;

test("the breadcrumb switches branches and every page follows", async ({
  page
}) => {
  await seed(page);
  const state = await mockBranches(page);
  await page.goto(`/projects/${ids.project}/overview`);
  await expect(page.getByText("2 tasks on this branch")).toBeVisible();
  await expectNoAxe(page);
  await branchMenu(page, "main").click();
  await expect(
    page.getByRole("menuitemradio", { name: /feat\/checkout/ })
  ).toContainText("Unread messages");
  await expect(
    page.getByRole("menuitem", { name: "All branches…" })
  ).toBeVisible();
  await expectNoAxe(page, '[role="menu"]');
  await page.getByRole("menuitemradio", { name: /feat\/checkout/ }).click();
  await expect(branchMenu(page, "feat/checkout")).toBeVisible();
  expect(search(page).get("branch")).toBe(ids.checkout);
  await expect(page.getByText("1 tasks on this branch")).toBeVisible();

  for (const [destination, text] of [
    ["Tasks", "Checkout copy"],
    ["Documents", "checkout.md"],
    ["Messages", "Checkout review"]
  ] as const) {
    await page.getByRole("button", { name: destination, exact: true }).click();
    await expect(page.getByText(text).first()).toBeVisible();
    expect(search(page).get("branch")).toBe(ids.checkout);
  }
  for (const collection of ["/tasks", "/documents", "/chats", "/events"])
    expect(state.seen).toContain(`${collection}:${ids.checkout}`);

  // Archived branches stay out of the menu; All branches finds them.
  await branchMenu(page, "feat/checkout").click();
  await page.getByRole("menuitem", { name: "All branches…" }).click();
  const all = page.getByRole("dialog", { name: "All branches" });
  await expect(
    all.getByText("Archived", { exact: true }).first()
  ).toBeVisible();
  await expectNoAxe(page);
  await page.keyboard.type("old");
  await page.getByRole("option", { name: /feat\/old/ }).click();
  await expect(page.getByText("feat/old is archived.")).toBeVisible();
});

test("the branch selector works from the keyboard", async ({ page }) => {
  await seed(page);
  await mockBranches(page);
  await page.goto(`/projects/${ids.project}/tasks`);
  const trigger = branchMenu(page, "main");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitemradio", { name: /feat\/checkout/ })
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(branchMenu(page, "feat/checkout")).toBeVisible();
  expect(search(page).get("branch")).toBe(ids.checkout);
});

test("@phone a new branch is set up by picking items, with explicit conflicts", async ({
  page
}) => {
  await seed(page);
  const state = await mockBranches(page, { importStaleOnce: true });
  await page.goto(`/projects/${ids.project}/tasks`);
  await expect(page.getByText("Schema")).toBeVisible();
  // Search works on every width; the breadcrumb hides on phones.
  await openSearch(page);
  await page.getByPlaceholder("Search commands…").fill("New branch");
  await page.getByRole("option", { name: "New branch" }).click();
  const create = page.getByRole("dialog", { name: "New branch" });
  await expect(create).toBeVisible();
  await expectNoAxe(page);
  await create.getByLabel("Branch name").fill("feat/search");
  await create.getByRole("button", { name: "Create branch" }).click();

  const panel = page.getByRole("region", { name: "Set up feat/search" });
  await expect(panel).toContainText(
    "1 task and 1 document already here will be kept."
  );
  await expectNoAxe(page);
  await panel.getByRole("radio", { name: "Pick items…" }).click();
  await panel.getByRole("button", { name: "Continue" }).click();

  const dialog = page.getByRole("dialog", { name: "Import into feat/search" });
  const api = dialog.getByRole("checkbox", { name: /DASH-2 API/ });
  const schema = dialog.getByRole("checkbox", { name: /DASH-1 Schema/ });
  const importButton = dialog.getByRole("button", { name: "Import" });
  await expect(api).not.toBeChecked();
  await expect(importButton).toBeDisabled();
  await expectNoAxe(page);
  await api.click();
  await expect(schema).toBeChecked();
  await expect(schema).toBeDisabled();
  await expect(dialog).toContainText("Required by DASH-2");
  // The exact preview loads after a short pause; scan once it's settled.
  await expect(importButton).toBeEnabled();

  await dialog.getByRole("tab", { name: /Chats/ }).click();
  await expect(
    dialog.getByRole("checkbox", { name: /Release/ })
  ).toBeDisabled();
  await expect(dialog).toContainText("More people would see this conversation");
  await expectNoAxe(page);

  await dialog.getByRole("tab", { name: /Documents/ }).click();
  await expectNoAxe(page);
  await dialog.getByRole("checkbox", { name: /README\.md/ }).click();
  await expect(dialog.getByText("Conflicts (1)")).toBeVisible();
  await expect(importButton).toBeDisabled();
  await expectNoAxe(page);
  const versions = dialog.getByRole("radiogroup", {
    name: "Version to keep for README.md"
  });
  await versions.getByRole("radio", { name: /Use target/ }).click();
  await expect(importButton).toBeEnabled();
  await importButton.click();

  // A stale preview keeps the selection and clears the changed conflict.
  await expect(
    dialog.getByText(
      "Things changed while you were choosing. The preview is refreshed and your selections were kept."
    )
  ).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Tasks (2)" })).toBeVisible();
  await expect(
    dialog.getByRole("tab", { name: "Documents (1)" })
  ).toBeVisible();
  await expect(
    versions.getByRole("radio", { name: /Use target/ })
  ).not.toBeChecked();
  await expect(importButton).toBeDisabled();
  await versions.getByRole("radio", { name: /Use source/ }).click();
  await importButton.click();
  await expect(
    page.getByText("Imported into feat/search from main.")
  ).toBeVisible();
  expect(state.applied).toHaveLength(2);
  expect(state.applied[1]).toMatchObject({
    kind: "import",
    selection: { tasks: [uuid(2)], documents: [uuid(21)], chats: [] },
    choices: { [uuid(21)]: "use_source" },
    complete_onboarding: true
  });
  await page.getByRole("button", { name: "Done" }).click();
  await expect(panel).toBeHidden();
});

test("the import dialog works from the keyboard", async ({ page }) => {
  await seed(page);
  const state = await mockBranches(page);
  state.branches.push(
    branchRow(ids.created, "feat/search", { onboarding_state: "pending" })
  );
  state.tasks[ids.created] = [];
  state.documents[ids.created] = [];
  state.chats[ids.created] = [];
  await page.goto(`/projects/${ids.project}/tasks?branch=${ids.created}`);
  const panel = page.getByRole("region", { name: "Set up feat/search" });
  await panel.getByRole("radio", { name: "Pick items…" }).focus();
  await page.keyboard.press("Space");
  await panel.getByRole("button", { name: "Continue" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Import into feat/search" });
  const api = dialog.getByRole("checkbox", { name: /DASH-2 API/ });
  await api.focus();
  await page.keyboard.press("Space");
  await expect(api).toBeChecked();
  await dialog.getByRole("tab", { name: /Tasks/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("tab", { name: /Documents/ })).toBeFocused();
  await page.keyboard.press("Enter");
  const readme = dialog.getByRole("checkbox", { name: /README\.md/ });
  await readme.focus();
  await page.keyboard.press("Space");
  const source = dialog
    .getByRole("radiogroup", { name: "Version to keep for README.md" })
    .getByRole("radio", { name: /Use source/ });
  await source.focus();
  await page.keyboard.press("Space");
  await expect(source).toBeChecked();
  await dialog.getByRole("button", { name: "Import" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Imported into feat/search from main.")
  ).toBeVisible();
});

test("@phone an archived branch is readable but has no write controls", async ({
  page
}) => {
  await seed(page);
  await mockBranches(page);
  await page.goto(`/projects/${ids.project}/tasks?branch=${ids.old}`);
  await expect(page.getByText("feat/old is archived.")).toBeVisible();
  await expect(
    page.getByText(
      /It was deleted on GitHub on Sep 27\. Its work is read-only\./
    )
  ).toBeVisible();
  await expect(page.getByText("Old experiment")).toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toHaveCount(0);
  await expectNoAxe(page);

  await page.goto(`/projects/${ids.project}/documents?branch=${ids.old}`);
  await expect(page.getByText("notes.md").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("button", { name: "Create document" })
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save now" })).toHaveCount(0);

  await page.goto(
    `/projects/${ids.project}/messages?branch=${ids.old}&chat=${uuid(33)}`
  );
  await expect(
    page.getByText("This branch is archived. Its conversations are read-only.")
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Write a message" })
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New message" })).toHaveCount(
    0
  );
});

test("@phone an owner merges and settles the decision", async ({ page }) => {
  await seed(page);
  const state = await mockBranches(page);
  await page.goto(`/projects/${ids.project}/settings#branches`);
  const section = page.locator("#branches");
  await expect(
    section.getByRole("heading", { name: "Branches" })
  ).toBeVisible();
  await expectNoAxe(page);
  await section
    .getByRole("button", { name: "Actions for feat/checkout" })
    .click();
  await page.getByRole("menuitem", { name: "Merge into…" }).click();
  const merge = page.getByRole("dialog", { name: "Merge feat/checkout" });
  await expect(merge).toContainText("1 document added");
  await expect(merge).toContainText("Will need your decision (1)");
  await expectNoAxe(page);
  await merge.getByRole("button", { name: "Merge" }).click();
  await expect(merge).toContainText("Merged feat/checkout into main.");
  await expect(merge).toContainText("1 item needs your decision.");
  await merge.getByRole("button", { name: "Done" }).click();

  await page.goto(`/projects/${ids.project}/decisions`);
  await expect(
    page.getByRole("button", { name: /DASH-7 Checkout copy/ })
  ).toBeVisible();
  await expectNoAxe(page);
  await page.getByRole("button", { name: /DASH-7 Checkout copy/ }).click();
  const sheet = page.getByRole("dialog", { name: "DASH-7 Checkout copy" });
  await expect(sheet).toContainText("Checkout text");
  await expectNoAxe(page);
  await sheet
    .getByRole("button", { name: "Use source (feat/checkout)" })
    .click();
  await expect(sheet).toBeHidden();
  expect(state.resolved).toEqual(["use_source"]);
  await expect(page.getByText("Nothing to decide")).toBeVisible();
});

test("the decisions sheet works from the keyboard", async ({ page }) => {
  await seed(page);
  const state = await mockBranches(page);
  state.decisions = [
    {
      id: uuid(401),
      project_id: ids.project,
      run_id: uuid(301),
      source_branch_id: ids.checkout,
      target_branch_id: ids.main,
      item_type: "task",
      lineage_key: uuid(7),
      source_item_id: uuid(7),
      target_item_id: uuid(9),
      label: "DASH-7 Checkout copy",
      reason: "changed_on_both",
      fields: ["title"],
      source_values: { title: "Checkout copy" },
      target_values: { title: "Checkout text" },
      status: "open",
      resolved_by_user_id: null,
      resolved_at: null,
      created_at: now
    }
  ];
  await page.goto(`/projects/${ids.project}/decisions`);
  await page.getByRole("button", { name: /DASH-7 Checkout copy/ }).focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "DASH-7 Checkout copy" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Use target (main)" }).focus();
  await page.keyboard.press("Enter");
  await expect(sheet).toBeHidden();
  expect(state.resolved).toEqual(["use_target"]);
});

test("@phone a repository connects through the provider redirect", async ({
  page
}) => {
  await seed(page);
  const state = await mockBranches(page);
  await page.goto(`/projects/${ids.project}/settings#repository`);
  const section = page.locator("#repository");
  await expect(
    section.getByRole("button", { name: "Connect GitLab.com" })
  ).toBeDisabled();
  await expectNoAxe(page);
  await section.getByRole("button", { name: "Connect GitHub" }).click();

  const picker = page.getByRole("dialog", { name: "Choose a repository" });
  await expect(
    picker.getByRole("radio", { name: /acme\/mirror/ })
  ).toBeDisabled();
  await expectNoAxe(page);
  await picker.getByRole("radio", { name: /acme\/app/ }).click();
  await picker.getByRole("button", { name: "Next" }).click();
  const mapping = page.getByRole("dialog", { name: "Default branch" });
  await expect(mapping).toContainText(
    "Your default branch main will be renamed to trunk and track it. All existing work stays."
  );
  await expectNoAxe(page);
  await mapping.getByRole("button", { name: "Connect" }).click();
  await expect(section.getByRole("link", { name: "acme/app" })).toBeVisible();
  // The wizard closes, and drops the param, after the data refreshes.
  await expect
    .poll(() => search(page).get("repository_authorization"))
    .toBeNull();
  // Connecting renamed the default to the provider's default.
  await expect(
    page.locator("#branches").getByText("trunk", { exact: true })
  ).toBeVisible();

  await section.getByRole("button", { name: "Sync now" }).click();
  await expect(
    section.getByText("Sync requested. Branches update shortly.")
  ).toBeVisible();
  await section.getByRole("button", { name: "Disconnect" }).click();
  const confirm = page.getByRole("dialog", { name: "Disconnect acme/app?" });
  await expect(confirm).toContainText("Branches and their work are kept.");
  await confirm.getByRole("button", { name: "Disconnect" }).click();
  await expect(
    section.getByRole("button", { name: "Connect GitHub" })
  ).toBeVisible();
  expect(state.repository).toBeNull();
});

test("switching branches waits for an unsaved document draft", async ({
  page
}) => {
  await seed(page);
  const state = await mockBranches(page);
  state.documentSaveFails = true;
  await page.goto(`/projects/${ids.project}/documents`);
  await page.getByRole("radio", { name: "Source mode" }).click();
  const source = page.locator(".mdxeditor-source-editor .cm-content");
  await source.click();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+End" : "Control+End"
  );
  await page.keyboard.type("\n\nUnsaved words.");
  await branchMenu(page, "main").click();
  await page.getByRole("menuitemradio", { name: /feat\/checkout/ }).click();
  const blocker = page.getByRole("dialog", { name: "Unsaved changes" });
  await expect(blocker).toContainText("You have unsaved changes in README.md.");
  await blocker.getByRole("button", { name: "Keep editing" }).click();
  expect(search(page).get("branch")).toBeNull();
  await expect(source).toContainText("Unsaved words.");
  await branchMenu(page, "main").click();
  await page.getByRole("menuitemradio", { name: /feat\/checkout/ }).click();
  await page.getByRole("button", { name: "Discard and switch" }).click();
  await expect(branchMenu(page, "feat/checkout")).toBeVisible();
  expect(search(page).get("branch")).toBe(ids.checkout);
});

test("@phone Search switches branches on a phone", async ({ page }) => {
  await seed(page);
  await mockBranches(page);
  await page.goto(`/projects/${ids.project}/tasks`);
  await expect(page.getByText("Schema")).toBeVisible();
  await openSearch(page);
  await page
    .getByPlaceholder("Search commands…")
    .fill("Switch to branch feat/checkout");
  await page
    .getByRole("option", { name: "Switch to branch feat/checkout" })
    .click();
  await expect(page.getByText("Checkout copy")).toBeVisible();
  expect(search(page).get("branch")).toBe(ids.checkout);
});
