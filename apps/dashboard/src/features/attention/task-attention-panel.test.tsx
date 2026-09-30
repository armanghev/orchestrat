import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { TaskComment } from "@orchestrat/protocol";
import { ApiClient } from "@/lib/api/client";
import { server } from "@/test/msw-server";
import {
  attentionSummary,
  attentionTaskItem,
  project,
  taskAttentionOverlay,
  taskCard,
  taskComment
} from "@/test/factories";
import { TaskAttentionBadge } from "./task-attention-badge";
import { TaskAttentionPanel, TaskClaimLine } from "./task-attention-panel";
import { taskCommentCounts, unreadCommentsLabel } from "./query-options";

const apiUrl = "http://localhost:8801/api/v1";
const projectId = project().id;
const taskId = taskCard().id;
const agentId = "00000000-0000-4000-8000-000000000020";

function attentionHandlers({
  watching = true,
  lastRead = 0,
  unread = 0,
  onWatch,
  onRead
}: {
  watching?: boolean;
  lastRead?: number;
  unread?: number;
  onWatch?: (body: unknown) => void;
  onRead?: (body: unknown) => void;
}) {
  let state = { watching, lastRead, unread };
  return [
    http.get(`${apiUrl}/projects/${projectId}/attention/tasks`, () =>
      HttpResponse.json({
        tasks: [
          taskAttentionOverlay({
            watching: state.watching,
            unread_count: state.unread
          })
        ]
      })
    ),
    http.get(`${apiUrl}/projects/${projectId}/attention`, () =>
      HttpResponse.json(
        attentionSummary({
          tasks: state.watching
            ? [
                attentionTaskItem({
                  last_read_sequence: state.lastRead,
                  unread_count: state.unread,
                  latest_sequence: state.lastRead + state.unread
                })
              ]
            : []
        })
      )
    ),
    http.post(`${apiUrl}/tasks/${taskId}/watch`, async ({ request }) => {
      const body = (await request.json()) as { watching: boolean };
      onWatch?.(body);
      state = { ...state, watching: body.watching };
      return HttpResponse.json({
        task_id: taskId,
        state: body.watching ? "watching" : "muted",
        reason: "explicit",
        last_read_sequence: state.lastRead
      });
    }),
    http.post(
      `${apiUrl}/tasks/${taskId}/comments/read`,
      async ({ request }) => {
        const body = (await request.json()) as { through_sequence: number };
        onRead?.(body);
        state = { ...state, lastRead: body.through_sequence, unread: 0 };
        return HttpResponse.json({
          task_id: taskId,
          state: "watching",
          reason: "explicit",
          last_read_sequence: body.through_sequence
        });
      }
    ),
    http.get(`${apiUrl}/projects/${projectId}/message-candidates`, () =>
      HttpResponse.json({
        candidates: [
          { type: "agent", id: agentId, name: "claude-code", avatar_url: null }
        ]
      })
    )
  ];
}

function renderPanel(
  comments: TaskComment[],
  onComment = vi.fn(async () => undefined)
) {
  const api = new ApiClient("http://localhost:8801", {
    getAccessToken: async () => "test-token",
    expireSession: async () => undefined
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TaskAttentionPanel
        api={api}
        projectId={projectId}
        taskId={taskId}
        comments={comments}
        archived={false}
        commenting={false}
        onComment={onComment}
      />
    </QueryClientProvider>
  );
  return { onComment };
}

describe("TaskAttentionBadge", () => {
  it("labels unread comments and mentions and hides when read", () => {
    const { rerender } = render(<TaskAttentionBadge unread={3} mentions={1} />);
    expect(
      screen.getByRole("img", { name: "3 unread comments, 1 mention" })
    ).toHaveTextContent("3@1");
    rerender(<TaskAttentionBadge unread={1} mentions={0} />);
    expect(
      screen.getByRole("img", { name: "1 unread comment" })
    ).toBeInTheDocument();
    rerender(<TaskAttentionBadge unread={0} mentions={0} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("sums summary counts for the sidebar", () => {
    expect(
      taskCommentCounts(
        attentionSummary({
          tasks: [
            attentionTaskItem({ unread_count: 2, mention_count: 1 }),
            attentionTaskItem({ unread_count: 1, mention_count: 0 })
          ]
        })
      )
    ).toEqual({ unread: 3, mentions: 1 });
    expect(unreadCommentsLabel(3, 2, "unread task comment")).toBe(
      "3 unread task comments, 2 mentions"
    );
  });
});

describe("TaskClaimLine", () => {
  it("shows the agent, task status, and remaining lease", () => {
    render(
      <TaskClaimLine
        status="in_progress"
        claim={{
          agent_id: agentId,
          agent_name: "claude-code",
          status: "active",
          lease_expires_at: new Date(Date.now() + 3.5 * 60_000).toISOString()
        }}
      />
    );
    expect(
      screen.getByText(/Claimed by/).textContent?.replace(/\s+/gu, " ")
    ).toBe("Claimed by claude-code · in progress · lease 4 min");
  });
});

describe("TaskAttentionPanel", () => {
  it("toggles watching with aria-pressed", async () => {
    const onWatch = vi.fn();
    server.use(...attentionHandlers({ watching: false, onWatch }));
    renderPanel([]);
    const toggle = await screen.findByRole("button", { name: "Watch task" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.setup().click(toggle);
    expect(onWatch).toHaveBeenCalledWith({ watching: true });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
  });

  it("places a New divider at the read position and marks visible comments read", async () => {
    const onRead = vi.fn();
    server.use(...attentionHandlers({ lastRead: 1, unread: 2, onRead }));
    renderPanel([
      taskComment({ sequence: 1, body_markdown: "Read already" }),
      taskComment({ sequence: 2, body_markdown: "First unread" }),
      taskComment({ sequence: 3, body_markdown: "Second unread" })
    ]);
    const list = screen.getByRole("list", { name: "Task comments" });
    const divider = await within(list).findByText("New", { exact: true });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Test UserRead already",
      "New",
      "Test UserFirst unread",
      "Test UserSecond unread"
    ]);
    await waitFor(() =>
      expect(onRead).toHaveBeenCalledWith({ through_sequence: 3 })
    );
    expect(onRead).toHaveBeenCalledOnce();
    // The divider stays put after the read position advances.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(divider).toBeInTheDocument();
  });

  it("does not report reads when nothing is unread", async () => {
    const onRead = vi.fn();
    server.use(...attentionHandlers({ lastRead: 2, onRead }));
    renderPanel([taskComment({ sequence: 1 }), taskComment({ sequence: 2 })]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Watch task" })).toBeEnabled()
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("New", { exact: true })).not.toBeInTheDocument();
    expect(onRead).not.toHaveBeenCalled();
  });

  it("sends picked mentions with the comment", async () => {
    server.use(...attentionHandlers({}));
    const { onComment } = renderPanel([]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Mention" }));
    await user.click(
      await screen.findByRole("button", { name: /claude-code/ })
    );
    const input = screen.getByRole("textbox", { name: "Add comment" });
    expect(input).toHaveValue("@claude-code ");
    await user.type(input, "please take a look");
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(onComment).toHaveBeenCalledWith("@claude-code please take a look", [
      { type: "agent", id: agentId }
    ]);
    await waitFor(() => expect(input).toHaveValue(""));
    expect(
      screen.queryByRole("button", { name: "Remove claude-code" })
    ).not.toBeInTheDocument();
  });
});
