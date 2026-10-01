import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { TaskBlock } from "@orchestrat/protocol";
import { ApiClient } from "@/lib/api/client";
import { server } from "@/test/msw-server";
import { project, taskBlock, taskCard } from "@/test/factories";
import { BlockedCallout, BlockedTaskLine } from "./blocked-callout";
import { attentionKeys } from "./query-options";

const apiUrl = "http://localhost:8801/api/v1";
const projectId = project().id;
const taskId = taskCard().id;
const blockingTask = {
  id: "00000000-0000-4000-8000-000000000041",
  key: "DASH-4",
  title: "Ship the API"
};

function renderCallout(
  block: TaskBlock,
  { archived = false, onResolved = vi.fn() } = {}
) {
  const api = new ApiClient("http://localhost:8801", {
    getAccessToken: async () => "test-token",
    expireSession: async () => undefined
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <BlockedCallout
        api={api}
        projectId={projectId}
        taskKey="DASH-1"
        block={block}
        archived={archived}
        renderTaskLink={(task) => <a href={`#${task.id}`}>{task.key}</a>}
        onResolved={onResolved}
      />
    </QueryClientProvider>
  );
  return { invalidate, onResolved };
}

describe("BlockedTaskLine", () => {
  it("renders one muted line with a status dot", () => {
    render(
      <BlockedTaskLine block={taskBlock({ blocking_task: blockingTask })} />
    );
    expect(screen.getByText("Blocked by DASH-4")).toBeInTheDocument();
  });
});

describe("BlockedCallout", () => {
  it("shows the reason, blocker link, participant, and since", () => {
    renderCallout(
      taskBlock({
        blocking_task: blockingTask,
        blocked_on: {
          type: "agent",
          id: "00000000-0000-4000-8000-000000000021",
          name: "codex"
        },
        created_at: new Date(Date.now() - 5 * 60_000).toISOString()
      })
    );
    const callout = screen.getByRole("region", { name: "Blocked" });
    expect(
      within(callout).getByText("Waiting for the API contract.")
    ).toBeVisible();
    expect(
      within(callout).getByRole("link", { name: "DASH-4" })
    ).toHaveAttribute("href", `#${blockingTask.id}`);
    expect(within(callout).getByText("codex (agent)")).toBeVisible();
    expect(within(callout).getByText("5 min ago")).toBeVisible();
    expect(callout).toHaveTextContent("reported by claude-code");
  });

  it("confirms before resolving, then refreshes and hands focus back", async () => {
    const resolved = vi.fn();
    server.use(
      http.post(
        `${apiUrl}/tasks/${taskId}/block/resolve`,
        async ({ request }) => {
          resolved(await request.json());
          return HttpResponse.json(
            taskBlock({
              resolved_at: new Date().toISOString(),
              resolution: "resolved_by_human"
            })
          );
        }
      )
    );
    const { invalidate, onResolved } = renderCallout(taskBlock());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Resolve blocker" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Resolve blocker?"
    });
    expect(dialog).toHaveTextContent("DASH-1 returns to In progress");
    expect(resolved).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", { name: "Resolve blocker" })
    );
    await waitFor(() => expect(resolved).toHaveBeenCalledWith({}));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(onResolved).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: attentionKeys.project(projectId)
    });
  });

  it("keeps the dialog open with a plain error and returns focus to the trigger", async () => {
    server.use(
      http.post(`${apiUrl}/tasks/${taskId}/block/resolve`, () =>
        HttpResponse.json(
          {
            error: {
              code: "INTERNAL_ERROR",
              message: "Boom.",
              details: {},
              request_id: "req"
            }
          },
          { status: 500 }
        )
      )
    );
    const { invalidate, onResolved } = renderCallout(taskBlock());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Resolve blocker" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Resolve blocker" })
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The blocker wasn’t resolved. Try again."
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Resolve blocker" })
      ).toHaveFocus()
    );
    expect(onResolved).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("explains a blocker resolved elsewhere and refreshes once closed", async () => {
    server.use(
      http.post(`${apiUrl}/tasks/${taskId}/block/resolve`, () =>
        HttpResponse.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "No open block.",
              details: {},
              request_id: "req"
            }
          },
          { status: 404 }
        )
      )
    );
    const { invalidate, onResolved } = renderCallout(taskBlock());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Resolve blocker" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Resolve blocker" })
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This blocker was already resolved."
    );
    // The error stays readable until the person closes the dialog.
    expect(invalidate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: attentionKeys.project(projectId)
    });
  });

  it("hides Resolve blocker in read-only views", () => {
    renderCallout(taskBlock(), { archived: true });
    expect(
      screen.queryByRole("button", { name: "Resolve blocker" })
    ).not.toBeInTheDocument();
  });
});
