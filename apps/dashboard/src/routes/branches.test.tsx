import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle, useState } from "react";
import { http, HttpResponse, type RequestHandler } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Branch, Chat } from "@orchestrat/protocol";
import type { AuthClient, AuthSnapshot } from "@/features/auth/auth-client";
import { branch, documentDetail, project, taskCard } from "@/test/factories";
import { handlers } from "@/test/handlers";
import { renderDashboardRoute } from "@/test/render";

// The branch selector, `?branch=` and per-page scoping
// (docs/project-branches.md §11.1–§11.5, §11.9).

vi.mock("@/features/documents/markdown-editor", () => ({
  MarkdownEditor: forwardRef<
    { setMarkdown: (markdown: string) => void },
    {
      markdown: string;
      readOnly: boolean;
      onChange: (markdown: string) => void;
    }
  >(function TestMarkdownEditor({ markdown, readOnly, onChange }, ref) {
    const [value, setValue] = useState(markdown);
    useImperativeHandle(
      ref,
      () => ({
        setMarkdown(next) {
          setValue(next);
          onChange(next);
        }
      }),
      [onChange]
    );
    return (
      <textarea
        aria-label="Markdown content"
        value={value}
        disabled={readOnly}
        onChange={(event) => {
          setValue(event.target.value);
          onChange(event.target.value);
        }}
      />
    );
  })
}));

// cmdk (the All branches dialog) measures its list.
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserver);
Element.prototype.scrollIntoView = vi.fn();

const apiUrl = "http://localhost:8801/api/v1";
const expectedProject = project();
const projectId = expectedProject.id;
const selfId = "00000000-0000-4000-8000-000000000004";
const main = branch();
const feature = branch({
  id: "00000000-0000-4000-8000-000000000051",
  name: "feat/checkout",
  is_default: false,
  name_source: "user",
  created_via: "dashboard",
  updated_at: "2026-09-29T00:00:00.000Z"
});
const old = branch({
  id: "00000000-0000-4000-8000-000000000052",
  name: "feat/old",
  is_default: false,
  name_source: "provider",
  created_via: "provider",
  archived_at: "2026-09-27T12:00:00.000Z",
  archived_reason: "provider_deleted",
  provider: { provider: "github", state: "missing", head_sha: null }
});

class Auth implements AuthClient {
  readonly capabilities = { github: true, magicLink: true };
  constructor(private readonly snapshot: AuthSnapshot) {}
  initialize = async () => undefined;
  completeSignIn = async () => ({
    status: "success" as const,
    identityKey: "user"
  });
  getSnapshot = () => this.snapshot;
  subscribe = () => () => undefined;
  signInWithGitHub = async () => undefined;
  sendMagicLink = async () => undefined;
  signOut = async () => undefined;
  expireSession = async () => undefined;
  getAccessToken = async () =>
    this.snapshot.status === "signedIn" ? "test-token" : null;
}

function platform() {
  return {
    kind: "web" as const,
    preferences: {
      load: vi.fn(async () => null),
      save: vi.fn(async () => undefined)
    },
    openExternal: vi.fn(async () => undefined),
    onAuthCallback: vi.fn(async () => () => undefined)
  };
}

const branchOf = (request: Request) =>
  new URL(request.url).searchParams.get("branch_id") ?? main.id;

function chat(overrides: Partial<Chat> = {}): Chat {
  const timestamp = "2026-09-24T00:00:00.000Z";
  return {
    id: "00000000-0000-4000-8000-000000000061",
    project_id: projectId,
    kind: "direct",
    name: null,
    has_human: true,
    creator: { type: "human", id: selfId },
    participants: [
      { type: "human", id: selfId, name: "Test User", avatar_url: null },
      {
        type: "agent",
        id: "00000000-0000-4000-8000-000000000020",
        name: "codex",
        avatar_url: null
      }
    ],
    is_participant: true,
    can_manage: false,
    can_join: false,
    last_sequence: 0,
    last_read_sequence: 0,
    unread_count: 0,
    mention_count: 0,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides
  };
}

/** Branch-aware API mocks. `seen` records `<collection>:<branch id>`. */
function branchHandlers({
  branches = [main, feature, old],
  seen = [],
  chats = () => []
}: {
  branches?: Branch[];
  seen?: string[];
  chats?: (branchId: string) => Chat[];
} = {}): RequestHandler[] {
  const record = (collection: string, request: Request) => {
    seen.push(`${collection}:${branchOf(request)}`);
    return branchOf(request);
  };
  return [
    http.get(`${apiUrl}/profile`, () =>
      HttpResponse.json({
        user_id: selfId,
        provider: "github",
        username: "tester",
        full_name: "Test User",
        email: "test@example.com",
        avatar_url: null
      })
    ),
    http.get(`${apiUrl}/projects/:projectId/branches`, () =>
      HttpResponse.json({ branches })
    ),
    http.get(`${apiUrl}/projects/:projectId/tasks`, ({ request }) => {
      const branchId = record("tasks", request);
      return HttpResponse.json({
        tasks: [
          taskCard({
            branch_id: branchId,
            title: branchId === main.id ? "Main roadmap" : "Checkout flow"
          })
        ],
        total: 1,
        next_cursor: null
      });
    }),
    http.get(`${apiUrl}/projects/:projectId/documents`, ({ request }) => {
      record("documents", request);
      return HttpResponse.json({
        documents: [],
        folders: [],
        next_cursor: null
      });
    }),
    http.get(`${apiUrl}/projects/:projectId/chats`, ({ request }) =>
      HttpResponse.json({ chats: chats(record("chats", request)) })
    ),
    http.get(`${apiUrl}/projects/:projectId/inbox`, ({ request }) => {
      if (new URL(request.url).searchParams.get("all_branches") === "true")
        return HttpResponse.json({
          unread_chats: [
            {
              chat_id: "00000000-0000-4000-8000-000000000062",
              branch_id: feature.id,
              unread_count: 2,
              mention_count: 0
            }
          ]
        });
      record("inbox", request);
      return HttpResponse.json({ unread_chats: [] });
    }),
    http.get(`${apiUrl}/projects/:projectId/events`, ({ request }) => {
      record(
        new URL(request.url).searchParams.get("all_branches") === "true"
          ? "events-all"
          : "events",
        request
      );
      return HttpResponse.json({ events: [], next_cursor: null });
    }),
    ...handlers
  ];
}

function render(path: string, extra: RequestHandler[]) {
  return renderDashboardRoute({
    path,
    auth: new Auth({ status: "signedIn", identityKey: "user" }),
    platform: platform(),
    handlers: extra
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("project branches in the dashboard", () => {
  it("switches branches from the breadcrumb and keeps the branch across pages", async () => {
    const seen: string[] = [];
    const view = await render(
      `/projects/${projectId}/tasks`,
      branchHandlers({ seen })
    );
    expect(await screen.findByText("Main roadmap")).toBeVisible();
    expect(seen).toContain(`tasks:${main.id}`);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Branch: main" }));
    expect(
      screen.getByRole("menuitemradio", { name: /^main/ })
    ).toHaveAttribute("aria-checked", "true");
    // Unread dots carry text, never colour alone.
    expect(
      screen.getByRole("menuitemradio", { name: /feat\/checkout/ })
    ).toHaveTextContent("Unread messages");
    // Archived branches stay out of the menu but All branches lists them.
    expect(
      screen.queryByRole("menuitemradio", { name: /feat\/old/ })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "All branches…" })
    ).toBeVisible();
    await user.click(
      screen.getByRole("menuitemradio", { name: /feat\/checkout/ })
    );
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        branch: feature.id
      })
    );
    expect(await screen.findByText("Checkout flow")).toBeVisible();
    expect(seen).toContain(`tasks:${feature.id}`);
    expect(
      screen.getByRole("button", { name: "Branch: feat/checkout" })
    ).toBeVisible();

    // Sidebar navigation keeps ?branch= and the next page follows it.
    await user.click(screen.getByRole("button", { name: "Documents" }));
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/projects/${projectId}/documents`
      )
    );
    expect(view.router.state.location.search).toEqual({ branch: feature.id });
    await waitFor(() => expect(seen).toContain(`documents:${feature.id}`));

    await user.click(screen.getByRole("button", { name: "Overview" }));
    await screen.findByText("Online agents");
    expect(view.router.state.location.search).toEqual({ branch: feature.id });
    expect(seen).toContain(`events:${feature.id}`);
    expect(screen.getByText("1 tasks on this branch")).toBeVisible();

    // Back to the default: the URL drops ?branch=.
    await user.click(
      screen.getByRole("button", { name: "Branch: feat/checkout" })
    );
    await user.click(screen.getByRole("menuitemradio", { name: /^main/ }));
    await waitFor(() => expect(view.router.state.location.search).toEqual({}));
  });

  it("lists archived branches in All branches and opens them read-only", async () => {
    const view = await render(`/projects/${projectId}/tasks`, branchHandlers());
    await screen.findByText("Main roadmap");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Branch: main" }));
    await user.click(screen.getByRole("menuitem", { name: "All branches…" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Active");
    expect(dialog).toHaveTextContent("Archived");
    await user.click(screen.getByRole("option", { name: /feat\/old/ }));
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({ branch: old.id })
    );
    expect(await screen.findByText("feat/old is archived.")).toBeVisible();
  });

  it("keeps the branch through the project index redirect and drops it for another project", async () => {
    const view = await render(
      `/projects/${projectId}?branch=${feature.id}`,
      branchHandlers()
    );
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/projects/${projectId}/overview`
      )
    );
    expect(view.router.state.location.search).toEqual({ branch: feature.id });
    await act(async () => {
      await view.router.navigate({
        to: "/projects/$projectId/agents",
        params: { projectId }
      });
    });
    expect(view.router.state.location.search).toEqual({ branch: feature.id });
  });

  it("shows Branch unavailable for a branch the project doesn't have", async () => {
    const view = await render(
      `/projects/${projectId}/tasks?branch=00000000-0000-4000-8000-000000000099`,
      branchHandlers()
    );
    expect(
      await screen.findByRole("heading", { name: "Branch unavailable" })
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Go to default branch" })
    );
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/projects/${projectId}/overview`
      )
    );
    expect(view.router.state.location.search).toEqual({});
    await screen.findByText("Online agents");
  });

  it("names its branch in every page request", async () => {
    const seen: string[] = [];
    const extra = branchHandlers({ seen });
    const view = await render(
      `/projects/${projectId}/overview?branch=${feature.id}`,
      extra
    );
    await screen.findByText("Online agents");
    for (const page of ["tasks", "documents", "messages", "activity", "agents"])
      await act(async () => {
        await view.router.navigate({
          to: `/projects/${projectId}/${page}` as never
        });
      });
    await waitFor(() =>
      expect(seen).toEqual(
        expect.arrayContaining([
          `tasks:${feature.id}`,
          `events:${feature.id}`,
          `documents:${feature.id}`,
          `chats:${feature.id}`,
          `inbox:${feature.id}`,
          "events-all:" + main.id
        ])
      )
    );
    // Nothing on these pages fell back to the default branch.
    expect(
      seen.filter(
        (entry) => entry.endsWith(main.id) && !entry.startsWith("events-all")
      )
    ).toEqual([]);
  });

  it("hides every write control on an archived branch", async () => {
    const archivedChat = chat();
    const view = await render(`/projects/${projectId}/tasks?branch=${old.id}`, [
      http.get(`${apiUrl}/chats/:chatId/messages`, () =>
        HttpResponse.json({
          messages: [],
          has_more: false,
          next_after: null,
          next_before: null
        })
      ),
      ...branchHandlers({ chats: () => [archivedChat] })
    ]);
    expect(await screen.findByText("feat/old is archived.")).toBeVisible();
    expect(
      screen.getByText(
        /It was deleted on GitHub on Sep 27\. Its work is read-only\./
      )
    ).toBeVisible();
    await screen.findByText("Checkout flow");
    expect(
      screen.queryByRole("button", { name: "New task" })
    ).not.toBeInTheDocument();

    await act(async () => {
      await view.router.navigate({
        to: "/projects/$projectId/documents",
        params: { projectId }
      });
    });
    await screen.findByText("Make room for shared context");
    expect(
      screen.queryByRole("button", { name: "Create document" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create folder" })
    ).not.toBeInTheDocument();

    await act(async () => {
      await view.router.navigate({
        to: "/projects/$projectId/messages",
        params: { projectId },
        search: { chat: archivedChat.id }
      });
    });
    expect(
      await screen.findByText(
        "This branch is archived. Its conversations are read-only."
      )
    ).toBeVisible();
    expect(
      screen.queryByRole("textbox", { name: "Write a message" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New message" })
    ).not.toBeInTheDocument();
    expect(view.router.state.location.search).toEqual({
      branch: old.id,
      chat: archivedChat.id
    });
  });

  it("offers to switch when a task link names another branch's task", async () => {
    const elsewhere = taskCard({
      id: "00000000-0000-4000-8000-000000000071",
      key: "DASH-7",
      title: "Checkout copy",
      branch_id: feature.id
    });
    const view = await render(
      `/projects/${projectId}/tasks?task=${elsewhere.id}`,
      [
        http.get(`${apiUrl}/tasks/${elsewhere.id}`, () =>
          HttpResponse.json(elsewhere)
        ),
        http.get(`${apiUrl}/tasks/${elsewhere.id}/comments`, () =>
          HttpResponse.json({ comments: [], next_cursor: null })
        ),
        http.get(`${apiUrl}/tasks/${elsewhere.id}/dependencies`, () =>
          HttpResponse.json({ depends_on: [], blocks: [] })
        ),
        ...branchHandlers()
      ]
    );
    expect(await screen.findByText(/This task is on/)).toHaveTextContent(
      "This task is on feat/checkout."
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to feat/checkout" })
    );
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        task: elsewhere.id,
        branch: feature.id
      })
    );
    expect(
      await screen.findByRole("heading", { name: "Checkout copy" })
    ).toBeVisible();
  });

  it("creates a branch from the menu and opens it", async () => {
    const created = branch({
      id: "00000000-0000-4000-8000-000000000053",
      name: "feat/search",
      is_default: false,
      name_source: "user",
      created_via: "dashboard",
      onboarding_state: "pending"
    });
    let branches = [main, feature];
    let body: unknown;
    const view = await render(`/projects/${projectId}/tasks`, [
      http.get(`${apiUrl}/projects/:projectId/branches`, () =>
        HttpResponse.json({ branches })
      ),
      http.post(
        `${apiUrl}/projects/:projectId/branches`,
        async ({ request }) => {
          body = await request.json();
          branches = [...branches, created];
          return HttpResponse.json({ branch: created }, { status: 201 });
        }
      ),
      ...branchHandlers()
    ]);
    await screen.findByText("Main roadmap");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Branch: main" }));
    await user.click(screen.getByRole("menuitem", { name: "New branch" }));
    const name = await screen.findByLabelText("Branch name");
    expect(
      screen.getByText(
        "Use the Git branch name. Agents on this Git branch will join it automatically."
      )
    ).toBeVisible();
    await user.type(name, "feat search");
    await user.click(screen.getByRole("button", { name: "Create branch" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Branch names cannot contain spaces"
    );
    expect(body).toBeUndefined();
    await user.clear(name);
    await user.type(name, "feat/search");
    await user.click(screen.getByRole("button", { name: "Create branch" }));
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        branch: created.id
      })
    );
    expect(body).toEqual({ name: "feat/search" });
    expect(
      await screen.findByRole("button", { name: "Branch: feat/search" })
    ).toBeVisible();
  });

  it("saves a pending document draft before switching branches", async () => {
    const document = documentDetail();
    const saved: unknown[] = [];
    const view = await render(`/projects/${projectId}/documents`, [
      http.get(`${apiUrl}/projects/:projectId/documents`, ({ request }) =>
        HttpResponse.json({
          documents: branchOf(request) === main.id ? [document.document] : [],
          folders: [],
          next_cursor: null
        })
      ),
      http.get(`${apiUrl}/documents/${document.document.id}`, () =>
        HttpResponse.json(document)
      ),
      http.get(`${apiUrl}/documents/${document.document.id}/revisions`, () =>
        HttpResponse.json({ revisions: [], next_cursor: null })
      ),
      http.patch(
        `${apiUrl}/documents/${document.document.id}`,
        async ({ request }) => {
          saved.push(await request.json());
          return HttpResponse.json({
            ...document,
            document: { ...document.document, current_revision: 2 },
            revision: {
              ...document.revision,
              revision_number: 2,
              content: "Draft before switching"
            }
          });
        }
      ),
      ...branchHandlers()
    ]);
    const editor = await screen.findByLabelText("Markdown content");
    fireEvent.change(editor, { target: { value: "Draft before switching" } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Branch: main" }));
    await user.click(
      screen.getByRole("menuitemradio", { name: /feat\/checkout/ })
    );
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        branch: feature.id
      })
    );
    expect(saved).toEqual([
      {
        content: "Draft before switching",
        base_revision: 1,
        save_kind: "autosave"
      }
    ]);
  });

  it("asks before discarding a draft that can't be saved", async () => {
    const document = documentDetail();
    const view = await render(`/projects/${projectId}/documents`, [
      http.get(`${apiUrl}/projects/:projectId/documents`, ({ request }) =>
        HttpResponse.json({
          documents: branchOf(request) === main.id ? [document.document] : [],
          folders: [],
          next_cursor: null
        })
      ),
      http.get(`${apiUrl}/documents/${document.document.id}`, () =>
        HttpResponse.json(document)
      ),
      http.get(`${apiUrl}/documents/${document.document.id}/revisions`, () =>
        HttpResponse.json({ revisions: [], next_cursor: null })
      ),
      http.patch(
        `${apiUrl}/documents/${document.document.id}`,
        () => new HttpResponse(null, { status: 500 })
      ),
      ...branchHandlers()
    ]);
    const editor = await screen.findByLabelText("Markdown content");
    fireEvent.change(editor, { target: { value: "Unsaved words" } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Branch: main" }));
    await user.click(
      screen.getByRole("menuitemradio", { name: /feat\/checkout/ })
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Unsaved changes"
    });
    expect(dialog).toHaveTextContent(
      `You have unsaved changes in ${document.document.path}.`
    );
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(view.router.state.location.search).toEqual({});
    expect(screen.getByLabelText("Markdown content")).toHaveValue(
      "Unsaved words"
    );

    await user.click(screen.getByRole("button", { name: "Branch: main" }));
    await user.click(
      screen.getByRole("menuitemradio", { name: /feat\/checkout/ })
    );
    await user.click(
      await screen.findByRole("button", { name: "Discard and switch" })
    );
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        branch: feature.id
      })
    );
  });
});
