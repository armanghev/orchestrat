import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle, useState } from "react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { branchKeys } from "@/features/branches/query-options";
import { branch, documentDetail, project, taskCard } from "@/test/factories";
import {
  apiUrl,
  branchHandlers,
  branchOf,
  chat,
  feature,
  main,
  old,
  projectId,
  render,
  selfId
} from "@/test/branch-routes";

// The branch selector, `?branch=` and per-page scoping.

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

  it("waits for an autosave on its way before switching", async () => {
    const document = documentDetail();
    const saved: Array<{ content: string }> = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
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
          const body = (await request.json()) as { content: string };
          saved.push(body);
          await held;
          return HttpResponse.json({
            ...document,
            document: { ...document.document, current_revision: 2 },
            revision: {
              ...document.revision,
              revision_number: 2,
              content: body.content
            }
          });
        }
      ),
      ...branchHandlers()
    ]);
    const editor = await screen.findByLabelText("Markdown content");
    fireEvent.change(editor, { target: { value: "Saving on its own" } });
    // The autosave is still on its way when the person switches.
    await waitFor(() => expect(saved).toHaveLength(1), { timeout: 3_000 });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Branch: main" }));
    await user.click(
      screen.getByRole("menuitemradio", { name: /feat\/checkout/ })
    );
    release();
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({
        branch: feature.id
      })
    );
    expect(
      screen.queryByRole("dialog", { name: "Unsaved changes" })
    ).not.toBeInTheDocument();
    expect(saved).toEqual([
      expect.objectContaining({ content: "Saving on its own" })
    ]);
  });

  it("stays on the branch it showed when the default moves", async () => {
    const document = documentDetail();
    const seen: string[] = [];
    let branches = [main, feature, old];
    const view = await render(`/projects/${projectId}/documents`, [
      http.get(`${apiUrl}/projects/:projectId/branches`, () =>
        HttpResponse.json({ branches })
      ),
      http.get(`${apiUrl}/projects/:projectId/documents`, ({ request }) => {
        seen.push(branchOf(request));
        return HttpResponse.json({
          documents: branchOf(request) === main.id ? [document.document] : [],
          folders: [],
          next_cursor: null
        });
      }),
      http.get(`${apiUrl}/documents/${document.document.id}`, () =>
        HttpResponse.json(document)
      ),
      http.get(`${apiUrl}/documents/${document.document.id}/revisions`, () =>
        HttpResponse.json({ revisions: [], next_cursor: null })
      ),
      http.patch(
        `${apiUrl}/documents/${document.document.id}`,
        async ({ request }) => {
          const { content } = (await request.json()) as { content: string };
          return HttpResponse.json({
            ...document,
            document: { ...document.document, current_revision: 2 },
            revision: { ...document.revision, revision_number: 2, content }
          });
        }
      ),
      ...branchHandlers()
    ]);
    const editor = await screen.findByLabelText("Markdown content");
    fireEvent.change(editor, { target: { value: "Draft on main" } });
    editor.focus();
    const entries = view.router.history.length;

    // Another admin makes feat/checkout the default.
    branches = [
      { ...feature, is_default: true },
      { ...main, is_default: false },
      old
    ];
    await act(() =>
      view.queryClient.invalidateQueries({
        queryKey: branchKeys.list(projectId)
      })
    );
    // The URL now names the branch on screen, in place of the old entry.
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({ branch: main.id })
    );
    expect(view.router.history.length).toBe(entries);
    expect(screen.getByRole("button", { name: "Branch: main" })).toBeVisible();
    // Not a new page, so focus stays in the editor.
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(screen.getByLabelText("Markdown content")).toHaveFocus();
    expect(screen.getByLabelText("Markdown content")).toHaveValue(
      "Draft on main"
    );
    expect(seen).not.toContain(feature.id);
    expect(
      screen.queryByRole("dialog", { name: "Unsaved changes" })
    ).not.toBeInTheDocument();

    // Choosing the new default drops ?branch= again.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Branch: main" }));
    await user.click(
      screen.getByRole("menuitemradio", { name: /feat\/checkout/ })
    );
    await waitFor(() => expect(view.router.state.location.search).toEqual({}));
    expect(
      await screen.findByRole("button", { name: "Branch: feat/checkout" })
    ).toBeVisible();
  });
});

describe("branch settings", () => {
  const preview = (
    fingerprint: string,
    extra: Partial<{
      counts: Record<string, number>;
    }> = {}
  ) => ({
    fingerprint: fingerprint.repeat(64).slice(0, 64),
    kind: "merge",
    source_branch_id: feature.id,
    target_branch_id: main.id,
    counts: { "task.copy": 2, "document.apply": 1, "task.conflict": 1 },
    items: [
      {
        item_type: "task",
        lineage_key: "00000000-0000-4000-8000-000000000081",
        source_id: "00000000-0000-4000-8000-000000000081",
        target_id: "00000000-0000-4000-8000-000000000082",
        outcome: "conflict",
        reason: "changed_on_both",
        fields: ["title"],
        required_by: [],
        label: "Checkout copy",
        task_key: "DASH-7",
        audience: null,
        source_values: { title: "Checkout copy" },
        target_values: { title: "Checkout text" }
      },
      {
        item_type: "chat",
        lineage_key: "00000000-0000-4000-8000-000000000083",
        source_id: "00000000-0000-4000-8000-000000000083",
        target_id: null,
        outcome: "skipped",
        reason: "audience_would_widen",
        fields: [],
        required_by: [],
        label: "Design review",
        task_key: null,
        audience: [],
        source_values: null,
        target_values: null
      }
    ],
    ...extra
  });
  const settingsHandlers = (role: "owner" | "member") => [
    http.get(`${apiUrl}/organizations/:organizationId/projects`, () =>
      HttpResponse.json({ projects: [project({ role })] })
    ),
    http.get(`${apiUrl}/projects/:projectId/members`, () =>
      HttpResponse.json({ members: [] })
    ),
    http.get(`${apiUrl}/projects/:projectId/invitations`, () =>
      HttpResponse.json({ invitations: [] })
    ),
    http.get(`${apiUrl}/projects/:projectId/merges`, () =>
      HttpResponse.json({
        runs: [
          {
            id: "00000000-0000-4000-8000-000000000091",
            project_id: projectId,
            source_branch_id: feature.id,
            target_branch_id: main.id,
            kind: "merge",
            trigger: "provider_merge",
            status: "applied_with_decisions",
            skip_reason: null,
            provider: {
              provider: "github",
              change_number: "42",
              change_url: "https://github.com/acme/app/pull/42",
              head_sha: "a1",
              merge_sha: "b2"
            },
            counts: { "task.copy": 3 },
            skipped: [],
            decision_count: 1,
            created_by: null,
            created_at: "2026-09-29T10:00:00.000Z",
            applied_at: "2026-09-29T10:00:00.000Z"
          }
        ],
        next_cursor: null
      })
    )
  ];

  it("shows members the branches and history but no owner actions", async () => {
    await render(`/projects/${projectId}/settings`, [
      ...settingsHandlers("member"),
      ...branchHandlers()
    ]);
    const section = await screen.findByRole("heading", { name: "Branches" });
    expect(section).toBeVisible();
    expect(screen.getByRole("cell", { name: /feat\/checkout/ })).toBeVisible();
    // Members can only import, and never into the default branch.
    expect(
      screen.queryByRole("button", { name: "Actions for main" })
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Actions for feat/checkout" })
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(["Import into this branch"]);
    await user.keyboard("{Escape}");
    // Archived branches appear only on request.
    expect(screen.queryByText("feat/old")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: "Show archived (1)" })
    );
    expect(screen.getByText("feat/old")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: "Merge history" }));
    expect(await screen.findByText("Merge feat/checkout → main")).toBeVisible();
    expect(screen.getByRole("link", { name: "PR #42" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/pull/42"
    );
    expect(screen.getByText(/3 tasks added · 1 decision/)).toBeVisible();
  });

  it("asks owners before setting the default or archiving", async () => {
    const posted: string[] = [];
    let branches = [main, feature, old];
    const view = await render(`/projects/${projectId}/settings`, [
      ...settingsHandlers("owner"),
      http.get(`${apiUrl}/projects/:projectId/branches`, () =>
        HttpResponse.json({ branches })
      ),
      http.post(
        `${apiUrl}/projects/:projectId/branches/:branchId/:action`,
        ({ params }) => {
          posted.push(`${params.action}:${params.branchId}`);
          if (params.action === "default")
            branches = [
              { ...feature, is_default: true },
              { ...main, is_default: false },
              old
            ];
          return HttpResponse.json({ branch: feature });
        }
      ),
      ...branchHandlers()
    ]);
    const user = userEvent.setup();
    // The default can be merged elsewhere but never archived or re-defaulted.
    await user.click(
      await screen.findByRole("button", { name: "Actions for main" })
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent)
    ).toEqual(["Merge into…", "Import into this branch"]);
    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", { name: "Actions for feat/checkout" })
    );
    await user.click(screen.getByRole("menuitem", { name: "Set as default" }));
    const confirm = await screen.findByRole("dialog", {
      name: "Make feat/checkout the default branch?"
    });
    expect(confirm).toHaveTextContent(
      "including older CLI versions, will read and write there. main stays as a regular branch."
    );
    await user.click(screen.getByRole("button", { name: "Make default" }));
    await waitFor(() => expect(posted).toEqual([`default:${feature.id}`]));
    // The page stays on the branch it showed.
    await waitFor(() =>
      expect(view.router.state.location.search).toEqual({ branch: main.id })
    );
    expect(screen.getByRole("button", { name: "Branch: main" })).toBeVisible();

    // main stays as a regular branch, so it can be archived now.
    await user.click(screen.getByRole("button", { name: "Actions for main" }));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(
      await screen.findByRole("dialog", { name: "Archive main?" })
    ).toHaveTextContent(
      "It becomes read-only and hidden. Nothing is deleted. Active agent sessions on it will be closed."
    );
    await user.click(screen.getByRole("button", { name: "Archive branch" }));
    await waitFor(() =>
      expect(posted).toEqual([`default:${feature.id}`, `archive:${main.id}`])
    );
  });

  it("previews a merge, merges and keeps going after a stale preview", async () => {
    const requests: Array<{
      body: Record<string, unknown>;
      key: string | null;
    }> = [];
    await render(`/projects/${projectId}/settings`, [
      ...settingsHandlers("owner"),
      http.post(`${apiUrl}/projects/:projectId/merges/preview`, () =>
        HttpResponse.json({ preview: preview("a") })
      ),
      http.post(`${apiUrl}/projects/:projectId/merges`, async ({ request }) => {
        requests.push({
          body: (await request.json()) as Record<string, unknown>,
          key: request.headers.get("idempotency-key")
        });
        if (requests.length === 1)
          return HttpResponse.json(
            {
              error: {
                code: "BRANCH_PREVIEW_STALE",
                message: "The preview is out of date.",
                request_id: "req_1",
                details: {
                  preview: preview("b", {
                    counts: { "task.copy": 3, "task.conflict": 1 }
                  })
                }
              }
            },
            { status: 409 }
          );
        return HttpResponse.json(
          {
            run: {
              id: "00000000-0000-4000-8000-000000000092",
              project_id: projectId,
              source_branch_id: feature.id,
              target_branch_id: main.id,
              kind: "merge",
              trigger: "dashboard",
              status: "applied_with_decisions",
              skip_reason: null,
              provider: null,
              counts: { "task.copy": 3 },
              skipped: [],
              decision_count: 1,
              created_by: { type: "human", id: selfId },
              created_at: "2026-09-30T10:00:00.000Z",
              applied_at: "2026-09-30T10:00:00.000Z"
            }
          },
          { status: 201 }
        );
      }),
      ...branchHandlers()
    ]);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Actions for feat/checkout" })
    );
    await user.click(screen.getByRole("menuitem", { name: "Merge into…" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Merge feat/checkout"
    });
    expect(screen.getByLabelText("Into")).toHaveValue(main.id);
    expect(await screen.findByText("2 tasks added")).toBeVisible();
    expect(screen.getByText("1 document updated")).toBeVisible();
    expect(dialog).toHaveTextContent("Will need your decision (1)");
    expect(dialog).toHaveTextContent("DASH-7Checkout copy");
    expect(dialog).toHaveTextContent("Changed on both branches");
    expect(dialog).toHaveTextContent("Won’t be merged (1)");
    expect(dialog).toHaveTextContent("More people would see this conversation");
    // The source isn't tracked by a provider, so archiving is suggested.
    expect(
      screen.getByRole("checkbox", {
        name: "Archive feat/checkout after merging"
      })
    ).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Merge" }));
    expect(
      await screen.findByText(/Things changed while you were choosing/)
    ).toBeVisible();
    expect(screen.getByText("3 tasks added")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Merge" }));
    expect(
      await screen.findByText("Merged feat/checkout into main.")
    ).toBeVisible();
    expect(screen.getByText("1 item needs your decision.")).toBeVisible();
    expect(requests.map(({ body }) => body)).toEqual([
      {
        source_branch_id: feature.id,
        target_branch_id: main.id,
        kind: "merge",
        preview_fingerprint: "a".repeat(64),
        archive_source: true
      },
      {
        source_branch_id: feature.id,
        target_branch_id: main.id,
        kind: "merge",
        preview_fingerprint: "b".repeat(64),
        archive_source: true
      }
    ]);
    // A new preview gets a new idempotency key.
    expect(requests[0]?.key).toBeTruthy();
    expect(requests[1]?.key).not.toBe(requests[0]?.key);
  });
});
