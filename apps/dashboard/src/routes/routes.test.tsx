import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import type { AuthClient, AuthSnapshot } from "@/features/auth/auth-client";
import { documentDetail, project, taskCard } from "@/test/factories";
import { renderDashboardRoute } from "@/test/render";
import { handlers } from "@/test/handlers";
import { coordinationKeys } from "@/features/coordination/query-options";

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
        `http://localhost:3001/api/v1/projects/${expected.id}/tasks`,
        () =>
          HttpResponse.json({
            tasks: [currentTask],
            total: 1,
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:3001/api/v1/projects/${expected.id}/agents`,
        () => HttpResponse.json({ agents: [agent] })
      ),
      http.get(
        `http://localhost:3001/api/v1/projects/${expected.id}/presence`,
        () =>
          HttpResponse.json({
            agents: [
              {
                agent_id: agentId,
                project_id: expected.id,
                session_id: "00000000-0000-4000-8000-000000000010",
                status: "online",
                last_heartbeat_at: "2024-01-01T00:00:00.000Z",
                current_task_id: currentTask.id
              }
            ]
          })
      ),
      http.get(
        `http://localhost:3001/api/v1/projects/${expected.id}/events`,
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
    expect(screen.getByText("DASH-1 · Compile release")).toBeVisible();
    expect(screen.getByText("1", { selector: "dd" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Overview" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Tasks" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Agents" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Documents" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Activity" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Messages" })
    ).not.toBeInTheDocument();
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
        `http://localhost:3001/api/v1/projects/${expectedProject.id}/tasks`,
        () =>
          HttpResponse.json({ tasks, total: tasks.length, next_cursor: null })
      ),
      http.post(
        `http://localhost:3001/api/v1/projects/${expectedProject.id}/tasks`,
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
        `http://localhost:3001/api/v1/projects/${expectedProject.id}/tasks`,
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
  });

  it("refetches and replaces stale task data after a version conflict", async () => {
    const expectedProject = project();
    const stale = taskCard({
      project_id: expectedProject.id,
      title: "Stale title",
      version: 1
    });
    const latest = taskCard({
      project_id: expectedProject.id,
      title: "Latest title",
      version: 2
    });
    let detailRequests = 0;
    const taskHandlers = [
      http.get(
        `http://localhost:3001/api/v1/projects/${expectedProject.id}/tasks`,
        () => HttpResponse.json({ tasks: [stale], total: 1, next_cursor: null })
      ),
      http.get(`http://localhost:3001/api/v1/tasks/${stale.id}`, () => {
        detailRequests += 1;
        return HttpResponse.json(detailRequests === 1 ? stale : latest);
      }),
      http.get(`http://localhost:3001/api/v1/tasks/${stale.id}/comments`, () =>
        HttpResponse.json({ comments: [], next_cursor: null })
      ),
      http.get(
        `http://localhost:3001/api/v1/tasks/${stale.id}/dependencies`,
        () => HttpResponse.json({ depends_on: [], blocks: [] })
      ),
      http.patch(`http://localhost:3001/api/v1/tasks/${stale.id}`, () =>
        HttpResponse.json(
          {
            error: {
              code: "TASK_VERSION_CONFLICT",
              message: "Task changed.",
              details: { current_version: 2 },
              request_id: "req_conflict"
            }
          },
          { status: 409 }
        )
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
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "changed elsewhere"
    );
    expect(await screen.findByDisplayValue("Latest title")).toBeVisible();
    expect(detailRequests).toBeGreaterThanOrEqual(2);
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
        `http://localhost:3001/api/v1/projects/${expectedProject.id}/events`,
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
    expect(await screen.findByText("Task Created")).toBeVisible();
    expect(screen.queryByText("Tool Call")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Load more activity" })
    );
    await screen.findByText("Task Done");
    expect(screen.getAllByText("Task Updated")).toHaveLength(1);
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
        revision_number: 2,
        content: "Server content"
      }
    };
    let detailRequests = 0;
    let patchRequests = 0;
    const documentHandlers = [
      http.get(
        `http://localhost:3001/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [initial.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:3001/api/v1/documents/${initial.document.id}`,
        () => {
          detailRequests += 1;
          return HttpResponse.json(detailRequests === 1 ? initial : current);
        }
      ),
      http.get(
        `http://localhost:3001/api/v1/documents/${initial.document.id}/revisions`,
        () =>
          HttpResponse.json({
            revisions: [initial.revision, current.revision].map(
              revisionSummary
            ),
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:3001/api/v1/documents/${initial.document.id}/revisions/1`,
        () => HttpResponse.json({ revision: initial.revision })
      ),
      http.patch(
        `http://localhost:3001/api/v1/documents/${initial.document.id}`,
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
    await user.click(screen.getByRole("button", { name: "Revision 1" }));
    expect(await screen.findByDisplayValue("Initial content")).toBeVisible();
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
        `http://localhost:3001/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [current.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:3001/api/v1/documents/${initial.document.id}`,
        () => HttpResponse.json(current)
      ),
      http.get(
        `http://localhost:3001/api/v1/documents/${initial.document.id}/revisions`,
        () =>
          HttpResponse.json({
            revisions: [current.revision].map(revisionSummary),
            next_cursor: null
          })
      ),
      http.patch(
        `http://localhost:3001/api/v1/documents/${initial.document.id}`,
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
        `http://localhost:3001/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [current.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:3001/api/v1/documents/${initial.document.id}`,
        () => HttpResponse.json(current)
      ),
      http.get(
        `http://localhost:3001/api/v1/documents/${initial.document.id}/revisions`,
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
        `http://localhost:3001/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [initial.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:3001/api/v1/documents/${initial.document.id}`,
        () => HttpResponse.json(attempts > 1 ? saved : initial)
      ),
      http.get(
        `http://localhost:3001/api/v1/documents/${initial.document.id}/revisions`,
        () =>
          HttpResponse.json({
            revisions: [initial.revision].map(revisionSummary),
            next_cursor: null
          })
      ),
      http.patch(
        `http://localhost:3001/api/v1/documents/${initial.document.id}`,
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
      expect(screen.getByRole("status")).toHaveTextContent("Offline, retrying");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(attempts).toBe(2);
      expect(screen.getByRole("status")).toHaveTextContent("Saved revision 2");
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
        `http://localhost:3001/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [initial.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:3001/api/v1/documents/${initial.document.id}`,
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
        `http://localhost:3001/api/v1/documents/${initial.document.id}/revisions`,
        () =>
          HttpResponse.json({
            revisions: [initial.revision].map(revisionSummary),
            next_cursor: null
          })
      ),
      http.patch(
        `http://localhost:3001/api/v1/documents/${initial.document.id}`,
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
        `http://localhost:3001/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [current.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:3001/api/v1/documents/${initial.document.id}`,
        () => HttpResponse.json(current)
      ),
      http.get(
        `http://localhost:3001/api/v1/documents/${initial.document.id}/revisions`,
        () =>
          HttpResponse.json({
            revisions: [current.revision].map(revisionSummary),
            next_cursor: null
          })
      ),
      http.patch(
        `http://localhost:3001/api/v1/documents/${initial.document.id}`,
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
        `http://localhost:3001/api/v1/projects/${expectedProject.id}/documents`,
        () =>
          HttpResponse.json({
            documents: [archived.document],
            next_cursor: null
          })
      ),
      http.get(
        `http://localhost:3001/api/v1/documents/${archived.document.id}`,
        () => HttpResponse.json(archived)
      ),
      http.get(
        `http://localhost:3001/api/v1/documents/${archived.document.id}/revisions`,
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
    await user.click(screen.getByRole("button", { name: "Archived (1)" }));
    expect(await screen.findByLabelText("Markdown content")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Add attachment" })
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Rename" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Archive" })
    ).not.toBeInTheDocument();
  });
});
