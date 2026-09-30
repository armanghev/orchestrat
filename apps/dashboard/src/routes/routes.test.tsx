import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef, useImperativeHandle, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import type { AuthClient, AuthSnapshot } from "@/features/auth/auth-client";
import {
  attentionSummary,
  attentionTaskItem,
  documentDetail,
  project,
  taskAttentionOverlay,
  taskCard
} from "@/test/factories";
import { renderDashboardRoute } from "@/test/render";
import { handlers } from "@/test/handlers";
import { coordinationKeys } from "@/features/coordination/query-options";
import { ApiClient } from "@/lib/api/client";

vi.mock("@/features/documents/markdown-editor", () => ({
  MarkdownEditor: forwardRef<
    { setMarkdown: (markdown: string) => void },
    {
      markdown: string;
      readOnly: boolean;
      onChange: (markdown: string, initialMarkdownNormalize?: boolean) => void;
      imageUploadHandler: (file: File) => Promise<string | null>;
    }
  >(function TestMarkdownEditor(
    { markdown, readOnly, onChange, imageUploadHandler },
    ref
  ) {
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
      <>
        <textarea
          aria-label="Markdown content"
          value={value}
          disabled={readOnly}
          onChange={(event) => {
            setValue(event.target.value);
            onChange(event.target.value);
          }}
        />
        <input
          type="file"
          aria-label="Insert image"
          disabled={readOnly}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void imageUploadHandler(file).then((source) => {
              if (!source) return;
              const next = `![${file.name}](${source})`;
              setValue(next);
              onChange(next);
            });
          }}
        />
      </>
    );
  })
}));

vi.mock("@/features/documents/document-diff", () => ({
  DocumentDiff: ({
    original,
    current
  }: {
    original: string;
    current: string;
  }) => (
    <div aria-label="Revision comparison">
      <textarea aria-label="Original revision" value={original} readOnly />
      <textarea aria-label="Current saved revision" value={current} readOnly />
    </div>
  )
}));

class FakeAuthClient implements AuthClient {
  readonly capabilities = { github: true, magicLink: true };
  constructor(private readonly snapshot: AuthSnapshot) {}
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
    return this.snapshot.status === "signedIn" ? "test-token" : null;
  }
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

function revisionSummary(
  revision: ReturnType<typeof documentDetail>["revision"]
) {
  return {
    id: revision.id,
    document_id: revision.document_id,
    revision_number: revision.revision_number,
    content_size_bytes: revision.content.length,
    content_sha256: "a".repeat(64),
    author: revision.author,
    created_at: revision.created_at
  };
}

describe("dashboard routes", () => {
  it("shows browser sign-in at the signed-out root", async () => {
    await renderDashboardRoute({
      path: "/",
      auth: new FakeAuthClient({ status: "signedOut" }),
      platform: platform()
    });
    expect(
      await screen.findByRole("button", { name: "Continue with GitHub" })
    ).toBeVisible();
  });

  it("redirects an authenticated setup flow to its first project", async () => {
    const expected = project();
    const view = await renderDashboardRoute({
      path: "/setup",
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform()
    });
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/projects/${expected.id}/overview`
      )
    );
  });

  it("renders project overview metadata", async () => {
    const expected = project();
    await renderDashboardRoute({
      path: `/projects/${expected.id}/overview`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform()
    });
    await screen.findByText("Online agents");
    expect(screen.getByRole("heading", { name: "Overview" })).toBeVisible();
    expect(screen.getByText(expected.slug)).toBeVisible();
  });

  it("renders mission-control summaries and only MVP navigation", async () => {
    const expected = project();
    const currentTask = taskCard({
      project_id: expected.id,
      status: "in_progress",
      title: "Compile release"
    });
    const agentId = "00000000-0000-4000-8000-000000000009";
    const agent = {
      id: agentId,
      project_id: expected.id,
      name: "Codex",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      revoked_at: null
    };
    const overviewHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expected.id}/tasks`,
        () =>
          HttpResponse.json({
            tasks: [currentTask],
            total: 1,
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:8801/api/v1/projects/${expected.id}/agents`,
        () => HttpResponse.json({ agents: [agent] })
      ),
      http.get(
        `http://localhost:8801/api/v1/projects/${expected.id}/presence`,
        () =>
          HttpResponse.json({
            agents: [
              {
                agent_id: agentId,
                project_id: expected.id,
                session_id: "00000000-0000-4000-8000-000000000010",
                status: "online",
                last_heartbeat_at: new Date().toISOString(),
                current_task_id: currentTask.id
              }
            ]
          })
      ),
      http.get(
        `http://localhost:8801/api/v1/projects/${expected.id}/events`,
        () => HttpResponse.json({ events: [], next_cursor: null })
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expected.id}/overview`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: overviewHandlers
    });
    expect(await screen.findByText("Online agents")).toBeVisible();
    expect(screen.getByText("Codex")).toBeVisible();
    expect(screen.getByText("DASH-1")).toBeVisible();
    expect(screen.getByText("Compile release")).toBeVisible();
    expect(screen.getByText("1", { selector: "dd" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Overview" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Tasks" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Agents" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Documents" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Activity" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Messages" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Integrations" })
    ).not.toBeInTheDocument();
  });

  it("creates a task and shows it in the task board", async () => {
    const expectedProject = project();
    const created = taskCard({
      project_id: expectedProject.id,
      title: "Created task"
    });
    let tasks = [] as (typeof created)[];
    const taskHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/tasks`,
        () =>
          HttpResponse.json({ tasks, total: tasks.length, next_cursor: null })
      ),
      http.post(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/tasks`,
        async () => {
          tasks = [created];
          return HttpResponse.json(created, { status: 201 });
        }
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/tasks`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: taskHandlers
    });
    const user = userEvent.setup();
    const newTask = await screen.findByRole("button", { name: "New task" });
    expect(newTask.closest("[data-slot='top-toolbar']")).toBeVisible();
    await user.click(newTask);
    await user.type(await screen.findByLabelText("Title"), "Created task");
    await user.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByText("DASH-1")).toBeVisible();
  });

  it("renders claimed tasks in the task board", async () => {
    const expectedProject = project();
    const claimed = taskCard({
      project_id: expectedProject.id,
      status: "claimed",
      title: "Agent-owned task"
    });
    const taskHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/tasks`,
        () =>
          HttpResponse.json({ tasks: [claimed], total: 1, next_cursor: null })
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/tasks`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: taskHandlers
    });
    expect(await screen.findByText("Agent-owned task")).toBeVisible();
    expect(screen.getByRole("heading", { name: "claimed" })).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "List" }));
    expect(screen.getByRole("table")).toHaveTextContent("Agent-owned task");
    await user.type(
      screen.getByRole("textbox", { name: "Search tasks" }),
      "missing"
    );
    expect(screen.getByText("No matching tasks")).toBeVisible();
    await user.clear(screen.getByRole("textbox", { name: "Search tasks" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter task status" }),
      "done"
    );
    expect(screen.getByText("No matching tasks")).toBeVisible();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter task status" }),
      "claimed"
    );
    expect(screen.getByRole("table")).toHaveTextContent("Agent-owned task");
  });

  it("keeps an unsaved task draft after a version conflict", async () => {
    const expectedProject = project();
    const stale = taskCard({
      project_id: expectedProject.id,
      title: "Stale title",
      version: 1
    });
    let current = taskCard({
      project_id: expectedProject.id,
      title: "Latest title",
      version: 2
    });
    let detailRequests = 0;
    const taskHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/tasks`,
        () => HttpResponse.json({ tasks: [stale], total: 1, next_cursor: null })
      ),
      http.get(`http://localhost:8801/api/v1/tasks/${stale.id}`, () => {
        detailRequests += 1;
        return HttpResponse.json(detailRequests === 1 ? stale : current);
      }),
      http.get(`http://localhost:8801/api/v1/tasks/${stale.id}/comments`, () =>
        HttpResponse.json({ comments: [], next_cursor: null })
      ),
      http.get(
        `http://localhost:8801/api/v1/tasks/${stale.id}/dependencies`,
        () => HttpResponse.json({ depends_on: [], blocks: [] })
      ),
      http.patch(
        `http://localhost:8801/api/v1/tasks/${stale.id}`,
        async ({ request }) => {
          const body = await request.json();
          if (detailRequests < 2) {
            expect(body).toMatchObject({ expected_version: 1 });
            return HttpResponse.json(
              {
                error: {
                  code: "TASK_VERSION_CONFLICT",
                  message: "Task changed.",
                  details: { current_version: 2 },
                  request_id: "req_conflict"
                }
              },
              { status: 409 }
            );
          }
          expect(body).toMatchObject({
            expected_version: 2,
            title: "Local draft"
          });
          current = { ...current, title: "Local draft", version: 3 };
          return HttpResponse.json(current);
        }
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/tasks`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: taskHandlers
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /DASH-1/ }));
    await screen.findByRole("heading", { name: "Stale title" });
    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "Local draft");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText(/This task changed elsewhere/)
    ).toBeVisible();
    expect(await screen.findByDisplayValue("Local draft")).toBeVisible();
    expect(screen.getByText(/version 2/)).toBeVisible();
    expect(detailRequests).toBeGreaterThanOrEqual(2);
    await user.click(
      screen.getByRole("button", { name: "Keep my draft and retry" })
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.getByText(/version 3/)).toBeVisible());
  });

  it("opens a task sheet from its task deep link", async () => {
    const expectedProject = project();
    const task = taskCard({ project_id: expectedProject.id });
    const taskHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/tasks`,
        () => HttpResponse.json({ tasks: [task], total: 1, next_cursor: null })
      ),
      http.get(`http://localhost:8801/api/v1/tasks/${task.id}`, () =>
        HttpResponse.json(task)
      ),
      http.get(`http://localhost:8801/api/v1/tasks/${task.id}/comments`, () =>
        HttpResponse.json({ comments: [], next_cursor: null })
      ),
      http.get(
        `http://localhost:8801/api/v1/tasks/${task.id}/dependencies`,
        () => HttpResponse.json({ depends_on: [], blocks: [] })
      ),
      ...handlers
    ];
    const view = await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/tasks?task=${task.id}`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: taskHandlers
    });

    expect(await screen.findByDisplayValue(task.title)).toBeVisible();
    expect(view.router.state.location.search).toEqual({ task: task.id });
  });

  it("shows task attention in the sidebar and board and locks overlay claims", async () => {
    const expectedProject = project();
    const task = taskCard({
      project_id: expectedProject.id,
      status: "in_progress"
    });
    const taskHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/tasks`,
        () => HttpResponse.json({ tasks: [task], total: 1, next_cursor: null })
      ),
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/attention`,
        () =>
          HttpResponse.json(
            attentionSummary({
              tasks: [
                attentionTaskItem({
                  task_id: task.id,
                  unread_count: 3,
                  mention_count: 1,
                  last_read_sequence: 0,
                  latest_sequence: 3
                })
              ]
            })
          )
      ),
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/attention/tasks`,
        () =>
          HttpResponse.json({
            tasks: [
              taskAttentionOverlay({
                task_id: task.id,
                unread_count: 3,
                mention_count: 1,
                claim: {
                  agent_id: "00000000-0000-4000-8000-000000000020",
                  agent_name: "claude-code",
                  status: "active",
                  lease_expires_at: new Date(
                    Date.now() + 4 * 60_000
                  ).toISOString()
                }
              })
            ]
          })
      ),
      http.get(`http://localhost:8801/api/v1/tasks/${task.id}`, () =>
        HttpResponse.json(task)
      ),
      http.get(`http://localhost:8801/api/v1/tasks/${task.id}/comments`, () =>
        HttpResponse.json({ comments: [], next_cursor: null })
      ),
      http.get(
        `http://localhost:8801/api/v1/tasks/${task.id}/dependencies`,
        () => HttpResponse.json({ depends_on: [], blocks: [] })
      ),
      ...handlers
    ];
    const view = await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/tasks`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: taskHandlers
    });
    expect(
      await screen.findByRole("img", {
        name: "3 unread task comments, 1 mention"
      })
    ).toBeVisible();
    expect(
      await screen.findByRole("img", { name: "3 unread comments, 1 mention" })
    ).toBeVisible();
    await act(() =>
      view.router.navigate({
        to: "/projects/$projectId/tasks",
        params: { projectId: expectedProject.id },
        search: { task: task.id }
      })
    );
    expect(
      (await screen.findByText(/Claimed by/)).textContent?.replace(/\s+/gu, " ")
    ).toBe("Claimed by claude-code · in progress · lease 4 min");
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(
      screen.queryByRole("combobox", { name: "Move task status" })
    ).not.toBeInTheDocument();
  });

  it("rejects a task deep link from another project", async () => {
    const currentProject = project();
    const otherTask = taskCard({
      project_id: "00000000-0000-4000-8000-000000000099",
      title: "Task from another project"
    });
    const commentsRequested = vi.fn(() =>
      HttpResponse.json({ comments: [], next_cursor: null })
    );
    await renderDashboardRoute({
      path: `/projects/${currentProject.id}/tasks?task=${otherTask.id}`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: [
        http.get(`http://localhost:8801/api/v1/tasks/${otherTask.id}`, () =>
          HttpResponse.json(otherTask)
        ),
        http.get(
          `http://localhost:8801/api/v1/tasks/${otherTask.id}/comments`,
          commentsRequested
        ),
        ...handlers
      ]
    });
    expect(
      await screen.findByText(/This task belongs to a different project/)
    ).toBeVisible();
    expect(screen.queryByDisplayValue(otherTask.title)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save changes" })
    ).not.toBeInTheDocument();
    expect(commentsRequested).not.toHaveBeenCalled();
  });

  it("does not apply a pending save from one task to another task draft", async () => {
    const expectedProject = project();
    const first = taskCard({ project_id: expectedProject.id, title: "First" });
    const second = taskCard({
      id: "00000000-0000-4000-8000-000000000007",
      key: "DASH-2",
      project_id: expectedProject.id,
      title: "Second"
    });
    let finishSave: (() => void) | undefined;
    let saveStarted = false;
    const savePending = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const taskHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/tasks`,
        () =>
          HttpResponse.json({
            tasks: [first, second],
            total: 2,
            next_cursor: null
          })
      ),
      http.get(`http://localhost:8801/api/v1/tasks/${first.id}`, () =>
        HttpResponse.json(first)
      ),
      http.get(`http://localhost:8801/api/v1/tasks/${second.id}`, () =>
        HttpResponse.json(second)
      ),
      http.get(`http://localhost:8801/api/v1/tasks/:taskId/comments`, () =>
        HttpResponse.json({ comments: [], next_cursor: null })
      ),
      http.get(`http://localhost:8801/api/v1/tasks/:taskId/dependencies`, () =>
        HttpResponse.json({ depends_on: [], blocks: [] })
      ),
      http.patch(`http://localhost:8801/api/v1/tasks/${first.id}`, async () => {
        saveStarted = true;
        await savePending;
        return HttpResponse.json({
          ...first,
          title: "First draft",
          version: 2
        });
      }),
      ...handlers
    ];
    const view = await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/tasks?task=${first.id}`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: taskHandlers
    });
    const user = userEvent.setup();
    const title = await screen.findByLabelText("Title");
    await user.clear(title);
    await user.type(title, "First draft");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveStarted).toBe(true));
    await act(async () => {
      await view.router.navigate({
        to: "/projects/$projectId/tasks",
        params: { projectId: expectedProject.id },
        search: { task: second.id }
      });
    });
    expect(await screen.findByDisplayValue("Second")).toBeVisible();
    finishSave?.();
    await waitFor(() =>
      expect(screen.getByDisplayValue("Second")).toBeVisible()
    );
    expect(screen.queryByDisplayValue("First draft")).not.toBeInTheDocument();
  });

  it("adds and removes a dependency with the current task version", async () => {
    const expectedProject = project();
    const dependency = taskCard({
      id: "00000000-0000-4000-8000-000000000007",
      key: "DASH-2",
      project_id: expectedProject.id,
      title: "Prerequisite"
    });
    let current = taskCard({ project_id: expectedProject.id, version: 1 });
    let dependsOn = [] as (typeof current)[];
    const taskHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/tasks`,
        () =>
          HttpResponse.json({
            tasks: [current, dependency],
            total: 2,
            next_cursor: null
          })
      ),
      http.get(`http://localhost:8801/api/v1/tasks/${current.id}`, () =>
        HttpResponse.json(current)
      ),
      http.get(
        `http://localhost:8801/api/v1/tasks/${current.id}/comments`,
        () => HttpResponse.json({ comments: [], next_cursor: null })
      ),
      http.get(
        `http://localhost:8801/api/v1/tasks/${current.id}/dependencies`,
        () => HttpResponse.json({ depends_on: dependsOn, blocks: [] })
      ),
      http.post(
        `http://localhost:8801/api/v1/tasks/${current.id}/dependencies`,
        async ({ request }) => {
          expect(await request.json()).toEqual({
            depends_on_task_id: dependency.id,
            expected_version: 1
          });
          dependsOn = [dependency];
          current = { ...current, version: 2 };
          return HttpResponse.json(current);
        }
      ),
      http.delete(
        `http://localhost:8801/api/v1/tasks/${current.id}/dependencies/${dependency.id}`,
        async ({ request }) => {
          expect(await request.json()).toEqual({ expected_version: 2 });
          dependsOn = [];
          current = { ...current, version: 3 };
          return HttpResponse.json(current);
        }
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/tasks?task=${current.id}`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: taskHandlers
    });
    const user = userEvent.setup();
    await screen.findByDisplayValue(current.title);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Add task dependency" }),
      dependency.id
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(dependsOn).toEqual([]));
  });

  it("keeps task dependency and comment drafts after rejected mutations", async () => {
    const expectedProject = project();
    const task = taskCard({ project_id: expectedProject.id });
    const dependency = taskCard({
      id: "00000000-0000-4000-8000-000000000007",
      key: "DASH-2",
      project_id: expectedProject.id
    });
    let dependencyAttempts = 0;
    const taskHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/tasks`,
        () =>
          HttpResponse.json({
            tasks: [task, dependency],
            total: 2,
            next_cursor: null
          })
      ),
      http.get(`http://localhost:8801/api/v1/tasks/${task.id}`, () =>
        HttpResponse.json(task)
      ),
      http.get(`http://localhost:8801/api/v1/tasks/${task.id}/comments`, () =>
        HttpResponse.json({ comments: [], next_cursor: null })
      ),
      http.get(
        `http://localhost:8801/api/v1/tasks/${task.id}/dependencies`,
        () => HttpResponse.json({ depends_on: [], blocks: [] })
      ),
      http.post(
        `http://localhost:8801/api/v1/tasks/${task.id}/dependencies`,
        () => {
          dependencyAttempts += 1;
          return dependencyAttempts === 1
            ? HttpResponse.json(
                {
                  error: {
                    code: "TASK_VERSION_CONFLICT",
                    message: "Task changed.",
                    details: { current_version: 2 },
                    request_id: "req_dependency_conflict"
                  }
                },
                { status: 409 }
              )
            : HttpResponse.json(
                {
                  error: {
                    code: "TASK_DEPENDENCY_CYCLE",
                    message: "Cycle rejected.",
                    details: {},
                    request_id: "req_cycle"
                  }
                },
                { status: 409 }
              );
        }
      ),
      http.post(`http://localhost:8801/api/v1/tasks/${task.id}/comments`, () =>
        HttpResponse.json(
          {
            error: {
              code: "INTERNAL_ERROR",
              message: "Comment rejected.",
              details: {},
              request_id: "req_comment"
            }
          },
          { status: 500 }
        )
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/tasks?task=${task.id}`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: taskHandlers
    });
    const user = userEvent.setup();
    await screen.findByDisplayValue(task.title);
    const dependencyPicker = screen.getByRole("combobox", {
      name: "Add task dependency"
    });
    await user.selectOptions(dependencyPicker, dependency.id);
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "changed elsewhere"
    );
    expect(dependencyPicker).toHaveValue(dependency.id);
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "create a cycle"
    );
    expect(dependencyPicker).toHaveValue(dependency.id);
    const comment = screen.getByRole("textbox", { name: "Add comment" });
    await user.type(comment, "keep this comment");
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByText("Comment rejected.")).toBeVisible();
    expect(comment).toHaveValue("keep this comment");
  });

  it("paginates activity without rendering duplicate events", async () => {
    const expectedProject = project();
    const event = (id: number, type: string) => ({
      id,
      project_id: expectedProject.id,
      type,
      actor_agent_id: null,
      actor_user_id: null,
      entity_id: null,
      payload: {},
      occurred_at: "2024-01-01T00:00:00.000Z"
    });
    const activityHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/events`,
        ({ request }) =>
          request.url.includes("after=1")
            ? HttpResponse.json({
                events: [event(2, "task.updated"), event(3, "task.done")],
                next_cursor: null
              })
            : HttpResponse.json({
                events: [
                  event(1, "task.created"),
                  event(2, "task.updated"),
                  event(4, "tool.call")
                ],
                next_cursor: "1"
              })
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/activity`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: activityHandlers
    });
    const user = userEvent.setup();
    expect(await screen.findByText("System created a task")).toBeVisible();
    expect(screen.queryByText("tool call")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Load more activity" })
    );
    await screen.findByText("System completed a task");
    expect(screen.getAllByText("System updated a task")).toHaveLength(1);
  });

  it("links claim activity to its payload task", async () => {
    const expectedProject = project();
    const task = taskCard({ project_id: expectedProject.id });
    const agent = {
      id: "00000000-0000-4000-8000-000000000007",
      project_id: expectedProject.id,
      name: "Runner",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
      revoked_at: null
    };
    const activityHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/tasks`,
        () => HttpResponse.json({ tasks: [task], total: 1, next_cursor: null })
      ),
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/agents`,
        () => HttpResponse.json({ agents: [agent] })
      ),
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/events`,
        () =>
          HttpResponse.json({
            events: [
              {
                id: 1,
                project_id: expectedProject.id,
                type: "claim.completed",
                actor_agent_id: agent.id,
                actor_user_id: null,
                entity_id: "00000000-0000-4000-8000-000000000008",
                payload: { task_id: task.id },
                occurred_at: "2024-01-01T00:00:00.000Z"
              }
            ],
            next_cursor: null
          })
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/activity`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: activityHandlers
    });

    expect(await screen.findByText("Runner completed")).toBeVisible();
    expect(screen.getByRole("link", { name: task.key })).toHaveAttribute(
      "href",
      `/projects/${expectedProject.id}/tasks?task=${task.id}`
    );
  });

  it("nests documents in collapsible path folders", async () => {
    const expectedProject = project();
    const root = documentDetail({
      document: { ...documentDetail().document, project_id: expectedProject.id }
    });
    const setup = {
      ...root.document,
      id: "00000000-0000-4000-8000-000000000009",
      path: "guides/setup.md"
    };
    const security = {
      ...root.document,
      id: "00000000-0000-4000-8000-00000000000a",
      path: "guides/advanced/security.md"
    };
    const listed = [root.document, setup, security];
    let createdPath = "";
    let renamedPath = "";
    const documentHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: listed,
            folders: [
              {
                id: "00000000-0000-4000-8000-00000000000b",
                project_id: expectedProject.id,
                path: "empty",
                created_at: root.document.created_at
              }
            ],
            next_cursor: null
          })
      ),
      http.post(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/documents`,
        async ({ request }) => {
          createdPath = ((await request.json()) as { path: string }).path;
          return HttpResponse.json(
            {
              ...root,
              document: {
                ...root.document,
                id: "00000000-0000-4000-8000-00000000000c",
                path: createdPath
              }
            },
            { status: 201 }
          );
        }
      ),
      http.patch(
        `http://localhost:8801/api/v1/documents/${setup.id}/path`,
        async ({ request }) => {
          const body = (await request.json()) as {
            path: string;
            expected_revision: number;
          };
          renamedPath = body.path;
          expect(body.expected_revision).toBe(setup.current_revision);
          return HttpResponse.json({
            document: { ...setup, path: renamedPath }
          });
        }
      ),
      http.get(
        "http://localhost:8801/api/v1/documents/:documentId",
        ({ params }) => {
          const document = listed.find((item) => item.id === params.documentId);
          return document
            ? HttpResponse.json({
                document,
                revision: {
                  ...root.revision,
                  document_id: document.id
                }
              })
            : HttpResponse.json({}, { status: 404 });
        }
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/documents`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: documentHandlers
    });

    const user = userEvent.setup();
    await screen.findByRole("button", {
      name: "Expand guides folder"
    });
    expect(
      screen.getByRole("button", { name: "Expand empty folder" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Create folder" })).toBeVisible();
    expect(screen.queryByText("setup.md")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create document" }));
    const unnamed = screen.getByRole("textbox", {
      name: "New document name"
    });
    expect(unnamed).toHaveValue("");
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("textbox", { name: "New document name" })
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Create document in guides" })
    );
    const newPath = screen.getByRole("textbox", {
      name: "New document name in guides"
    });
    expect(newPath).toHaveValue("");
    await user.type(newPath, "quickstart{Enter}");
    await waitFor(() => expect(createdPath).toBe("guides/quickstart.md"));

    const openGuides = screen.getByRole("button", {
      name: "Collapse guides folder"
    });
    expect(openGuides.closest("li")).toContainElement(
      screen.getByText("setup.md")
    );
    await user.click(
      screen.getByRole("button", { name: "Rename guides/setup.md" })
    );
    const rename = screen.getByRole("textbox", {
      name: "Rename guides/setup.md"
    });
    await user.clear(rename);
    await user.type(rename, "install{Enter}");
    await waitFor(() => expect(renamedPath).toBe("guides/install.md"));

    const advanced = screen.getByRole("button", {
      name: "Expand guides/advanced folder"
    });
    expect(screen.queryByText("security.md")).not.toBeInTheDocument();

    await user.click(advanced);
    expect(advanced.closest("li")).toContainElement(
      screen.getByText("security.md")
    );

    await user.click(openGuides);
    expect(openGuides).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("setup.md")).not.toBeInTheDocument();
  });

  it("preserves an unsaved document draft after conflict and shows summary history", async () => {
    const expectedProject = project();
    const initial = documentDetail({
      document: { ...documentDetail().document, project_id: expectedProject.id }
    });
    const current = {
      ...initial,
      document: { ...initial.document, current_revision: 2 },
      revision: {
        ...initial.revision,
        id: `${initial.revision.id.slice(0, -1)}2`,
        revision_number: 2,
        content: "Server content"
      }
    };
    let detailRequests = 0;
    let patchRequests = 0;
    const documentHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [initial.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}`,
        () => {
          detailRequests += 1;
          return HttpResponse.json(detailRequests === 1 ? initial : current);
        }
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}/revisions`,
        () =>
          HttpResponse.json({
            revisions: [initial.revision, current.revision].map(
              revisionSummary
            ),
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}/revisions/1`,
        () => HttpResponse.json({ revision: initial.revision })
      ),
      http.patch(
        `http://localhost:8801/api/v1/documents/${initial.document.id}`,
        async ({ request }) => {
          patchRequests += 1;
          const body = (await request.json()) as {
            base_revision: number;
            content: string;
          };
          if (patchRequests === 2) {
            expect(body.base_revision).toBe(2);
            expect(body.content).toBe("Unsaved draft");
            return HttpResponse.json(
              {
                ...current,
                revision: { ...current.revision, content: body.content }
              },
              { status: 200 }
            );
          }
          expect(body.base_revision).toBe(1);
          return HttpResponse.json(
            {
              error: {
                code: "DOCUMENT_CONFLICT",
                message: "Document changed.",
                details: { current_revision: 2, base_revision: 1 },
                request_id: "req_document"
              }
            },
            { status: 409 }
          );
        }
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/documents`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: documentHandlers
    });
    const user = userEvent.setup();
    const editor = await screen.findByLabelText("Markdown content");
    await user.clear(editor);
    await user.type(editor, "Unsaved draft");
    await user.click(screen.getByRole("button", { name: "Save now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Revision conflict"
    );
    expect(screen.getAllByDisplayValue("Unsaved draft")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Continue merging" }));
    expect(screen.getByText("Autosave is paused while merging.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save mine" }));
    await waitFor(() => expect(patchRequests).toBe(2));
    expect(screen.getByDisplayValue("Unsaved draft")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Revision 1\b/ })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(
      await screen.findByRole("dialog", { name: "Document history" })
    ).toBeVisible();
    await user.click(
      await screen.findByRole("button", { name: /^Revision 1\b/ })
    );
    expect(await screen.findByLabelText("Original revision")).toHaveValue(
      "Initial content"
    );
  });

  it("retries and paginates document history without replacing the draft", async () => {
    const expectedProject = project();
    const seed = documentDetail({
      document: {
        ...documentDetail().document,
        project_id: expectedProject.id,
        current_revision: 6
      },
      revision: {
        ...documentDetail().revision,
        revision_number: 6,
        content: "Current saved content"
      }
    });
    const revisions = Array.from({ length: 6 }, (_, index) => ({
      ...seed.revision,
      id: `${seed.revision.id.slice(0, -1)}${6 - index}`,
      revision_number: 6 - index,
      content: `Saved content ${6 - index}`
    }));
    let historyRequests = 0;
    let olderRequests = 0;
    const documentHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({ documents: [seed.document], next_cursor: null })
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${seed.document.id}`,
        () => HttpResponse.json(seed)
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${seed.document.id}/revisions`,
        ({ request }) => {
          historyRequests += 1;
          if (historyRequests === 1)
            return HttpResponse.json(
              { error: { code: "TEMPORARY" } },
              { status: 500 }
            );
          const older =
            new URL(request.url).searchParams.get("cursor") === "older";
          if (older && ++olderRequests === 1)
            return HttpResponse.json(
              { error: { code: "TEMPORARY" } },
              { status: 500 }
            );
          return HttpResponse.json({
            revisions: (older
              ? revisions.slice(3)
              : [
                  { ...seed.revision, revision_number: 7 },
                  ...revisions.slice(0, 3)
                ]
            ).map(revisionSummary),
            next_cursor: older ? null : "older"
          });
        }
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${seed.document.id}/revisions/:revision`,
        ({ params }) => {
          const revision = revisions.find(
            (item) => item.revision_number === Number(params.revision)
          );
          return revision
            ? HttpResponse.json({ revision })
            : HttpResponse.json({}, { status: 404 });
        }
      ),
      http.patch(
        `http://localhost:8801/api/v1/documents/${seed.document.id}`,
        () => new Promise<Response>(() => undefined)
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/documents`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: documentHandlers
    });
    const user = userEvent.setup();
    const editor = await screen.findByLabelText("Markdown content");
    expect(
      screen.queryByRole("button", { name: /^Revision 5\b/ })
    ).not.toBeInTheDocument();
    await user.clear(editor);
    await user.type(editor, "Unsaved draft");
    await user.click(screen.getByRole("button", { name: "History" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Document history"
    });
    expect(dialog).toHaveTextContent(
      "Unsaved draft changes are excluded. Comparisons use the current saved version."
    );
    expect(await screen.findByText("Could not load history.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    const newestPrior = await screen.findByRole("button", {
      name: /^Revision 5\b/
    });
    expect(screen.getByRole("list", { name: /revisions$/ })).toBeVisible();
    expect(newestPrior).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("button", { name: /^Revision 6\b/ })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Revision 7\b/ })
    ).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Original revision")).toHaveValue(
      "Saved content 5"
    );
    expect(
      screen.getByRole("button", { name: "Restore as new revision" })
    ).toBeDisabled();
    expect(screen.getByLabelText("Current saved revision")).toHaveValue(
      "Current saved content"
    );
    expect(screen.getByLabelText("Original revision")).toHaveAttribute(
      "readonly"
    );

    await user.click(
      screen.getByRole("button", { name: "Load older revisions" })
    );
    expect(
      await screen.findByRole("button", { name: "Retry older revisions" })
    ).toBeVisible();
    expect(newestPrior).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Original revision")).toHaveValue(
      "Saved content 5"
    );
    await user.click(
      screen.getByRole("button", { name: "Retry older revisions" })
    );
    await user.click(
      await screen.findByRole("button", { name: /^Revision 2\b/ })
    );
    expect(await screen.findByLabelText("Original revision")).toHaveValue(
      "Saved content 2"
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(
      screen.queryByRole("dialog", { name: "Document history" })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Markdown content")).toHaveValue(
      "Unsaved draft"
    );
  });

  it("restores an old document version as a new revision", async () => {
    const expectedProject = project();
    const old = documentDetail({
      document: {
        ...documentDetail().document,
        project_id: expectedProject.id,
        current_revision: 3
      },
      revision: {
        ...documentDetail().revision,
        revision_number: 2,
        content: "Old content"
      }
    });
    let current = {
      ...old,
      revision: {
        ...old.revision,
        revision_number: 3,
        content: "Current content"
      }
    };
    let patchRequests = 0;
    const documentHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [current.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${old.document.id}`,
        () => HttpResponse.json(current)
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${old.document.id}/revisions`,
        () =>
          HttpResponse.json({
            revisions: [current.revision, old.revision].map(revisionSummary),
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${old.document.id}/revisions/2`,
        () => HttpResponse.json({ revision: old.revision })
      ),
      http.patch(
        `http://localhost:8801/api/v1/documents/${old.document.id}`,
        async ({ request }) => {
          patchRequests += 1;
          expect(await request.json()).toEqual({
            content: "Old content",
            base_revision: 3
          });
          current = {
            ...current,
            document: { ...current.document, current_revision: 4 },
            revision: {
              ...current.revision,
              revision_number: 4,
              content: "Old content"
            }
          };
          return HttpResponse.json(current);
        }
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/documents`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: documentHandlers
    });
    const user = userEvent.setup();
    await screen.findByLabelText("Markdown content");
    await user.click(screen.getByRole("button", { name: "History" }));
    await screen.findByRole("button", { name: /^Revision 2\b/ });
    const restore = await screen.findByRole("button", {
      name: "Restore as new revision"
    });
    await waitFor(() => expect(restore).toBeEnabled());
    await user.click(restore);
    await waitFor(() => expect(patchRequests).toBe(1));
    expect(
      screen.queryByRole("dialog", { name: "Document history" })
    ).not.toBeInTheDocument();
  });

  it("debounces autosaves and serializes a queued edit", async () => {
    const expectedProject = project();
    const initial = documentDetail({
      document: { ...documentDetail().document, project_id: expectedProject.id }
    });
    let current = initial;
    let resolveFirst!: () => void;
    const writes: Array<{
      content: string;
      base_revision: number;
      save_kind?: "autosave";
    }> = [];
    const documentHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [current.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}`,
        () => HttpResponse.json(current)
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}/revisions`,
        () =>
          HttpResponse.json({
            revisions: [current.revision].map(revisionSummary),
            next_cursor: null
          })
      ),
      http.patch(
        `http://localhost:8801/api/v1/documents/${initial.document.id}`,
        async ({ request }) => {
          const body = (await request.json()) as {
            content: string;
            base_revision: number;
          };
          writes.push(body);
          if (writes.length === 1)
            return new Promise<Response>((resolve) => {
              resolveFirst = () => {
                current = {
                  ...initial,
                  document: { ...initial.document, current_revision: 2 },
                  revision: {
                    ...initial.revision,
                    revision_number: 2,
                    content: body.content
                  }
                };
                resolve(HttpResponse.json(current));
              };
            });
          current = {
            ...current,
            document: { ...current.document, current_revision: 3 },
            revision: {
              ...current.revision,
              revision_number: 3,
              content: body.content
            }
          };
          return HttpResponse.json(current);
        }
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/documents`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: documentHandlers
    });
    const editor = await screen.findByLabelText("Markdown content");
    vi.useFakeTimers();
    try {
      fireEvent.change(editor, { target: { value: "First draft" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_499);
      });
      expect(writes).toHaveLength(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(writes).toHaveLength(1);
      fireEvent.change(editor, { target: { value: "Queued draft" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(writes).toHaveLength(1);
      await act(async () => {
        resolveFirst();
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(writes).toHaveLength(2);
      expect(writes).toEqual([
        {
          content: "First draft",
          base_revision: 1,
          save_kind: "autosave"
        },
        {
          content: "Queued draft",
          base_revision: 2,
          save_kind: "autosave"
        }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts clean remote revisions and preserves a dirty draft against newer revisions", async () => {
    const expectedProject = project();
    const initial = documentDetail({
      document: { ...documentDetail().document, project_id: expectedProject.id }
    });
    let current = initial;
    const documentHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [current.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}`,
        () => HttpResponse.json(current)
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}/revisions`,
        () =>
          HttpResponse.json({
            revisions: [current.revision].map(revisionSummary),
            next_cursor: null
          })
      ),
      ...handlers
    ];
    const view = await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/documents`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: documentHandlers
    });
    const editor = await screen.findByLabelText("Markdown content");
    current = {
      ...initial,
      document: { ...initial.document, current_revision: 2 },
      revision: {
        ...initial.revision,
        revision_number: 2,
        content: "Clean remote"
      }
    };
    await act(async () => {
      await view.queryClient.invalidateQueries({
        queryKey: coordinationKeys.document(initial.document.id)
      });
    });
    expect(await screen.findByDisplayValue("Clean remote")).toBeVisible();
    fireEvent.change(editor, { target: { value: "Human draft" } });
    current = {
      ...current,
      document: { ...current.document, current_revision: 3 },
      revision: {
        ...current.revision,
        revision_number: 3,
        content: "Remote three"
      }
    };
    await act(async () => {
      await view.queryClient.invalidateQueries({
        queryKey: coordinationKeys.document(initial.document.id)
      });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Revision conflict"
    );
    expect(screen.getAllByDisplayValue("Human draft")).toHaveLength(2);
    current = {
      ...current,
      document: { ...current.document, current_revision: 4 },
      revision: {
        ...current.revision,
        revision_number: 4,
        content: "Remote four"
      }
    };
    await act(async () => {
      await view.queryClient.invalidateQueries({
        queryKey: coordinationKeys.document(initial.document.id)
      });
    });
    expect(await screen.findByDisplayValue("Remote four")).toBeVisible();
    expect(screen.getAllByDisplayValue("Human draft")).toHaveLength(2);
  });

  it("retries an offline autosave after the debounce delay", async () => {
    const expectedProject = project();
    const initial = documentDetail({
      document: { ...documentDetail().document, project_id: expectedProject.id }
    });
    const saved = {
      ...initial,
      document: { ...initial.document, current_revision: 2 },
      revision: {
        ...initial.revision,
        revision_number: 2,
        content: "Offline draft"
      }
    };
    let attempts = 0;
    const documentHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [initial.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}`,
        () => HttpResponse.json(attempts > 1 ? saved : initial)
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}/revisions`,
        () =>
          HttpResponse.json({
            revisions: [initial.revision].map(revisionSummary),
            next_cursor: null
          })
      ),
      http.patch(
        `http://localhost:8801/api/v1/documents/${initial.document.id}`,
        () => {
          attempts += 1;
          return attempts === 1
            ? HttpResponse.error()
            : HttpResponse.json(saved);
        }
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/documents`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: documentHandlers
    });
    const editor = await screen.findByLabelText("Markdown content");
    vi.useFakeTimers();
    try {
      fireEvent.change(editor, { target: { value: "Offline draft" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(attempts).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(attempts).toBe(2);
      expect(editor).toHaveValue("Offline draft");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses autosave immediately after a conflict while the remote refetch is pending", async () => {
    const expectedProject = project();
    const initial = documentDetail({
      document: { ...documentDetail().document, project_id: expectedProject.id }
    });
    let detailRequests = 0;
    let resolveRemote!: () => void;
    let attempts = 0;
    const documentHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [initial.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}`,
        () => {
          detailRequests += 1;
          if (detailRequests === 1) return HttpResponse.json(initial);
          return new Promise<Response>((resolve) => {
            resolveRemote = () =>
              resolve(
                HttpResponse.json({
                  ...initial,
                  document: { ...initial.document, current_revision: 2 },
                  revision: {
                    ...initial.revision,
                    revision_number: 2,
                    content: "Remote revision"
                  }
                })
              );
          });
        }
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}/revisions`,
        () =>
          HttpResponse.json({
            revisions: [initial.revision].map(revisionSummary),
            next_cursor: null
          })
      ),
      http.patch(
        `http://localhost:8801/api/v1/documents/${initial.document.id}`,
        () => {
          attempts += 1;
          return HttpResponse.json(
            {
              error: {
                code: "DOCUMENT_CONFLICT",
                message: "Document changed.",
                details: { current_revision: 2, base_revision: 1 },
                request_id: "req_document"
              }
            },
            { status: 409 }
          );
        }
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/documents`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: documentHandlers
    });
    const editor = await screen.findByLabelText("Markdown content");
    fireEvent.change(editor, { target: { value: "Local draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save now" }));
    await waitFor(() => expect(attempts).toBe(1));
    await waitFor(() => expect(resolveRemote).toBeTypeOf("function"));
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
      await act(async () => {
        resolveRemote();
        await Promise.resolve();
      });
    }
  });

  it("keeps a newer remote comparison after an older save acknowledgement", async () => {
    const expectedProject = project();
    const initial = documentDetail({
      document: { ...documentDetail().document, project_id: expectedProject.id }
    });
    const acknowledged = {
      ...initial,
      document: { ...initial.document, current_revision: 2 },
      revision: {
        ...initial.revision,
        revision_number: 2,
        content: "Human draft"
      }
    };
    const remote = {
      ...initial,
      document: { ...initial.document, current_revision: 3 },
      revision: {
        ...initial.revision,
        revision_number: 3,
        content: "Agent revision"
      }
    };
    let current = initial;
    let resolveSave!: () => void;
    const documentHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [current.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}`,
        () => HttpResponse.json(current)
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}/revisions`,
        () =>
          HttpResponse.json({
            revisions: [current.revision].map(revisionSummary),
            next_cursor: null
          })
      ),
      http.patch(
        `http://localhost:8801/api/v1/documents/${initial.document.id}`,
        () =>
          new Promise<Response>((resolve) => {
            resolveSave = () => resolve(HttpResponse.json(acknowledged));
          })
      ),
      ...handlers
    ];
    const view = await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/documents`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: documentHandlers
    });
    const editor = await screen.findByLabelText("Markdown content");
    fireEvent.change(editor, { target: { value: "Human draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save now" }));
    await waitFor(() => expect(resolveSave).toBeTypeOf("function"));
    current = remote;
    await act(async () => {
      await view.queryClient.invalidateQueries({
        queryKey: coordinationKeys.document(initial.document.id)
      });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Revision conflict"
    );
    await act(async () => {
      resolveSave();
      await Promise.resolve();
    });
    expect(await screen.findByDisplayValue("Agent revision")).toBeVisible();
    expect(screen.getAllByDisplayValue("Human draft")).toHaveLength(2);
  });

  it("uploads editor images without rendering a separate attachment section", async () => {
    const expectedProject = project();
    const initial = documentDetail({
      document: { ...documentDetail().document, project_id: expectedProject.id }
    });
    const uploadId = "00000000-0000-4000-8000-000000000021";
    const attachment = {
      id: "00000000-0000-4000-8000-000000000022",
      document_id: initial.document.id,
      filename: "diagram.png",
      content_type: "image/png",
      size_bytes: 7,
      created_at: "2026-08-24T00:00:00.000Z"
    };
    const putPresignedObject = vi
      .spyOn(ApiClient.prototype, "putPresignedObject")
      .mockResolvedValue();
    const documentHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [initial.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}`,
        () => HttpResponse.json(initial)
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${initial.document.id}/revisions`,
        () =>
          HttpResponse.json({
            revisions: [initial.revision].map(revisionSummary),
            next_cursor: null
          })
      ),
      http.post(
        `http://localhost:8801/api/v1/documents/${initial.document.id}/attachments/uploads`,
        () =>
          HttpResponse.json({
            upload: {
              id: uploadId,
              mode: "single",
              upload_url: "https://storage.example.test/upload",
              expires_at: "2026-08-25T00:00:00.000Z"
            }
          })
      ),
      http.post(
        `http://localhost:8801/api/v1/documents/${initial.document.id}/attachments/uploads/${uploadId}/complete`,
        () => HttpResponse.json({ attachment })
      ),
      ...handlers
    ];
    try {
      await renderDashboardRoute({
        path: `/projects/${expectedProject.id}/documents`,
        auth: new FakeAuthClient({
          status: "signedIn",
          identityKey: "test-user"
        }),
        platform: platform(),
        handlers: documentHandlers
      });
      await screen.findByLabelText("Markdown content");
      fireEvent.change(screen.getByLabelText("Insert image"), {
        target: {
          files: [new File(["diagram"], "diagram.png", { type: "image/png" })]
        }
      });
      await waitFor(() => expect(putPresignedObject).toHaveBeenCalledOnce());
      expect(await screen.findByLabelText("Markdown content")).toHaveValue(
        `![diagram.png](orchestrat-attachment:${attachment.id})`
      );
      expect(screen.queryByText("Attachments")).not.toBeInTheDocument();
    } finally {
      putPresignedObject.mockRestore();
    }
  });

  it("renders archived documents as readable but non-editable", async () => {
    const expectedProject = project();
    const archived = documentDetail({
      document: {
        ...documentDetail().document,
        project_id: expectedProject.id,
        archived_at: "2026-08-24T00:00:00.000Z"
      }
    });
    const documentHandlers = [
      http.get(
        `http://localhost:8801/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [archived.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${archived.document.id}`,
        () => HttpResponse.json(archived)
      ),
      http.get(
        `http://localhost:8801/api/v1/documents/${archived.document.id}/revisions`,
        () =>
          HttpResponse.json({
            revisions: [archived.revision].map(revisionSummary),
            next_cursor: null
          })
      ),
      ...handlers
    ];
    await renderDashboardRoute({
      path: `/projects/${expectedProject.id}/documents`,
      auth: new FakeAuthClient({
        status: "signedIn",
        identityKey: "test-user"
      }),
      platform: platform(),
      handlers: documentHandlers
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Archived (1)" }));
    expect(await screen.findByLabelText("Markdown content")).toBeDisabled();
    expect(screen.getByLabelText("Insert image")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Document actions" }));
    expect(screen.getByRole("menuitem", { name: "Restore" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Rename" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Archive" })
    ).not.toBeInTheDocument();
  });
});
