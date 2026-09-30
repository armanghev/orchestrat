import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { AttentionTaskRef, ParticipantRef } from "@orchestrat/protocol";
import { ApiClient } from "@/lib/api/client";
import { server } from "@/test/msw-server";
import { project, taskCard } from "@/test/factories";
import { PingDialog } from "./ping-dialog";

const apiUrl = "http://localhost:8801/api/v1";
const projectId = project().id;
const userId = "00000000-0000-4000-8000-000000000004";
const codex = "00000000-0000-4000-8000-000000000021";
const claude = "00000000-0000-4000-8000-000000000020";
const teammate = "00000000-0000-4000-8000-000000000022";
const task: AttentionTaskRef = {
  id: taskCard().id,
  key: taskCard().key,
  title: taskCard().title
};

type Sent = { body: unknown; key: string | null };

function handlers(responses: Array<"ok" | "rate" | "network">) {
  const sent: Sent[] = [];
  server.use(
    http.get(`${apiUrl}/projects/${projectId}/message-candidates`, () =>
      HttpResponse.json({
        candidates: [
          { type: "agent", id: claude, name: "claude-code", avatar_url: null },
          { type: "agent", id: codex, name: "codex", avatar_url: null },
          { type: "human", id: teammate, name: "Ada", avatar_url: null }
        ]
      })
    ),
    http.post(
      `${apiUrl}/projects/${projectId}/handoffs`,
      async ({ request }) => {
        const body = (await request.json()) as {
          to: ParticipantRef;
          body_markdown: string;
          task_id?: string;
        };
        sent.push({ body, key: request.headers.get("idempotency-key") });
        const outcome = responses.shift() ?? "ok";
        if (outcome === "network") return HttpResponse.error();
        if (outcome === "rate")
          return HttpResponse.json(
            {
              error: {
                code: "HANDOFF_RATE_LIMITED",
                message: "Slow down.",
                details: {},
                request_id: "req"
              }
            },
            { status: 429 }
          );
        return HttpResponse.json({
          handoff: {
            id: "00000000-0000-4000-8000-000000000050",
            chat_id: "00000000-0000-4000-8000-000000000051",
            message_id: "00000000-0000-4000-8000-000000000052",
            message_sequence: 1,
            from: { type: "human", id: userId, name: "Test User" },
            to: { ...body.to, name: "codex" },
            task: body.task_id ? task : null,
            chain_id: "00000000-0000-4000-8000-000000000053",
            hop: 0,
            created_at: new Date().toISOString()
          }
        });
      }
    )
  );
  return sent;
}

function renderPing(props: Partial<Parameters<typeof PingDialog>[0]> = {}) {
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
      <PingDialog api={api} projectId={projectId} {...props} />
    </QueryClientProvider>
  );
  return { invalidate };
}

describe("PingDialog", () => {
  it("sends a prefilled task handoff from the keyboard and returns focus", async () => {
    const sent = handlers(["ok"]);
    renderPing({ task, defaultRecipient: { type: "agent", id: codex } });
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Ping" });
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Ping" });
    expect(dialog).toHaveTextContent(`Task ${task.key} · ${task.title}`);
    const recipient = within(dialog).getByRole("combobox", {
      name: "Recipient"
    });
    await waitFor(() => expect(recipient).toHaveValue(`agent:${codex}`));
    // The recipient is preset, so focus starts in the message.
    await waitFor(() =>
      expect(
        within(dialog).getByRole("textbox", { name: "Message" })
      ).toHaveFocus()
    );
    await user.keyboard("Can you review the API shape?");
    await user.keyboard("{Tab}{Tab}");
    expect(
      within(dialog).getByRole("button", { name: "Send ping" })
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      to: { type: "agent", id: codex },
      body_markdown: "Can you review the API shape?",
      task_id: task.id
    });
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/u);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("Ping sent to codex");
  });

  it("keeps the draft and reuses the idempotency key when a retry follows a failure", async () => {
    const sent = handlers(["network", "rate", "ok"]);
    renderPing();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Ping" }));
    const dialog = await screen.findByRole("dialog", { name: "Ping" });
    const recipient = within(dialog).getByRole("combobox", {
      name: "Recipient"
    });
    await within(dialog).findByRole("option", { name: "Ada" });
    expect(recipient).toHaveFocus();
    const send = within(dialog).getByRole("button", { name: "Send ping" });
    expect(send).toBeDisabled();
    await user.selectOptions(recipient, "Ada");
    await user.type(
      within(dialog).getByRole("textbox", { name: "Message" }),
      "Need a decision"
    );
    await user.click(send);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "We couldn’t reach Orchestrat."
    );
    expect(
      within(dialog).getByRole("textbox", { name: "Message" })
    ).toHaveValue("Need a decision");
    await user.click(send);
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Too many pings were sent recently."
      )
    );
    expect(sent[1]?.key).toBe(sent[0]?.key);
    // A changed draft is a new request, so it gets a new key.
    await user.type(
      within(dialog).getByRole("textbox", { name: "Message" }),
      " today"
    );
    await user.click(send);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(sent).toHaveLength(3);
    expect(sent[2]?.key).not.toBe(sent[0]?.key);
    expect(sent[2]?.body).toEqual({
      to: { type: "human", id: teammate },
      body_markdown: "Need a decision today"
    });
  });

  it("shows the pending state while sending", async () => {
    let release: () => void = () => undefined;
    server.use(
      http.get(`${apiUrl}/projects/${projectId}/message-candidates`, () =>
        HttpResponse.json({
          candidates: [
            { type: "agent", id: codex, name: "codex", avatar_url: null }
          ]
        })
      ),
      http.post(
        `${apiUrl}/projects/${projectId}/handoffs`,
        () =>
          new Promise<Response>((resolve) => {
            release = () =>
              resolve(
                HttpResponse.json(
                  {
                    error: {
                      code: "INTERNAL_ERROR",
                      message: "no",
                      details: {},
                      request_id: "r"
                    }
                  },
                  { status: 500 }
                )
              );
          })
      )
    );
    renderPing({ defaultRecipient: { type: "agent", id: codex } });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Ping" }));
    const dialog = await screen.findByRole("dialog", { name: "Ping" });
    await waitFor(() =>
      expect(
        within(dialog).getByRole("combobox", { name: "Recipient" })
      ).toHaveValue(`agent:${codex}`)
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "Message" }),
      "Ping"
    );
    await user.click(within(dialog).getByRole("button", { name: "Send ping" }));
    expect(
      await within(dialog).findByRole("button", { name: "Sending…" })
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("textbox", { name: "Message" })
    ).toBeDisabled();
    release();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The ping wasn’t sent. Try again."
    );
  });

  it("is disabled when the project is read-only", () => {
    renderPing({ disabled: true, triggerLabel: "Ping codex" });
    expect(screen.getByRole("button", { name: "Ping codex" })).toBeDisabled();
  });
});
