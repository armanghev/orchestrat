import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Chat,
  InboxSummary,
  RealtimeEventEnvelope
} from "@orchestrat/protocol";
import type { ApiClient } from "@/lib/api/client";
import type { Platform } from "@/platform/contract";
import { messagingKeys } from "@/features/messaging/query-options";
import {
  ProjectRealtimeProvider,
  useProjectRealtimeStatus,
  type SocketLike
} from "./project-realtime";

const projectOne = "11111111-1111-4111-8111-111111111111";
const projectTwo = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
const agentId = "44444444-4444-4444-8444-444444444444";
const secondAgentId = "55555555-5555-4555-8555-555555555555";
const chatOneId = "66666666-6666-4666-8666-666666666666";
const chatTwoId = "77777777-7777-4777-8777-777777777777";
const observerChatId = "88888888-8888-4888-8888-888888888888";
const messageId = "99999999-9999-4999-8999-999999999999";
const timestamp = "2026-09-24T00:00:00.000Z";

class TestSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  onmessage: SocketLike["onmessage"] = null;
  static instances: TestSocket[] = [];

  constructor(readonly url: string) {
    TestSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  emit(value: RealtimeEventEnvelope) {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }

  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  });

  send() {}
}

function makeChat(id: string, projectId: string, isParticipant = true): Chat {
  return {
    id,
    project_id: projectId,
    kind: "group",
    name: id === observerChatId ? "Agent planning" : "Build updates",
    has_human: id !== observerChatId,
    creator: { type: "agent", id: agentId },
    participants:
      id === observerChatId
        ? [
            { type: "agent", id: agentId, name: "Builder", avatar_url: null },
            {
              type: "agent",
              id: secondAgentId,
              name: "Planner",
              avatar_url: null
            }
          ]
        : [
            { type: "human", id: userId, name: "You", avatar_url: null },
            { type: "agent", id: agentId, name: "Builder", avatar_url: null }
          ],
    is_participant: isParticipant,
    can_manage: isParticipant,
    can_join: !isParticipant && id === observerChatId,
    last_sequence: 0,
    last_read_sequence: 0,
    unread_count: 0,
    mention_count: 0,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function event(
  projectId: string,
  sequence: number,
  chatId: string,
  eventType = "chat.message_created",
  actor: RealtimeEventEnvelope["actor"] = { type: "agent", id: agentId },
  mentions: RealtimeEventEnvelope["mentions"] = []
): RealtimeEventEnvelope {
  return {
    project_id: projectId,
    sequence,
    event_type: eventType,
    entity_type: "chat",
    entity_id: chatId,
    actor,
    message_id: messageId,
    mentions
  };
}

function desktopPlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    kind: "desktop",
    preferences: {
      load: vi.fn(async () => null),
      save: vi.fn(async () => undefined)
    },
    openExternal: vi.fn(async () => undefined),
    onAuthCallback: vi.fn(async () => () => undefined),
    ...overrides
  };
}

function makeHarness(options: {
  projectIds?: string[];
  activeProjectId?: string;
  chatsByProject?: Record<string, Chat[]>;
  inboxByProject?: Record<string, InboxSummary>;
  platform?: Platform;
  listProjectEvents?: (projectId: string) => Promise<{
    events: Array<Record<string, unknown>>;
    next_cursor: string | null;
  }>;
  getChat?: (chatId: string) => Promise<Chat>;
}) {
  const projectIds = options.projectIds ?? [projectOne];
  const chatsByProject = options.chatsByProject ?? {};
  const chatById = new Map(
    Object.values(chatsByProject)
      .flat()
      .map((chat) => [chat.id, chat])
  );
  const api = {
    createRealtimeTicket: vi.fn(async () => ({
      ticket: "a".repeat(32),
      expires_at: timestamp
    })),
    realtimeSocketUrl: vi.fn(() => "wss://api.example/realtime"),
    listProjectEvents: vi.fn(
      options.listProjectEvents ??
        (async () => ({ events: [], next_cursor: null }))
    ),
    getTask: vi.fn(async () => ({ status: "done", title: "Task" })),
    listChats: vi.fn(async (projectId: string) => ({
      chats: chatsByProject[projectId] ?? []
    })),
    getProjectInbox: vi.fn(
      async (projectId: string) =>
        options.inboxByProject?.[projectId] ?? { unread_chats: [] }
    ),
    getChat: vi.fn(
      options.getChat ??
        (async (chatId: string) =>
          chatById.get(chatId) ?? makeChat(chatId, projectOne))
    )
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const navigateToChat = vi.fn();
  const platform = options.platform ?? desktopPlatform({ kind: "web" });
  vi.stubGlobal("WebSocket", TestSocket);
  TestSocket.instances = [];
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProjectRealtimeProvider
        api={api as unknown as ApiClient}
        queryClient={queryClient}
        projectIds={projectIds}
        activeProjectId={options.activeProjectId ?? projectIds[0] ?? ""}
        currentUserId={userId}
        platform={platform}
        navigateToChat={navigateToChat}
      >
        <StatusDisplay />
      </ProjectRealtimeProvider>
    </QueryClientProvider>
  );
  return { ...view, api, queryClient, navigateToChat, platform, projectIds };
}

function StatusDisplay() {
  return (
    <span data-testid="realtime-status">{useProjectRealtimeStatus()}</span>
  );
}

async function openSockets(
  count: number,
  api: ReturnType<typeof makeHarness>["api"]
) {
  await waitFor(() => expect(TestSocket.instances).toHaveLength(count));
  await act(async () => {
    for (const socket of TestSocket.instances) socket.open();
  });
  await waitFor(() => expect(api.listChats).toHaveBeenCalledTimes(count));
  await waitFor(() =>
    expect(api.listProjectEvents).toHaveBeenCalledTimes(count)
  );
}

async function connectedHarness(
  options: Parameters<typeof makeHarness>[0] = {}
) {
  const harness = makeHarness(options);
  await openSockets(harness.projectIds.length, harness.api);
  await waitFor(() =>
    expect(screen.getByTestId("realtime-status")).toHaveTextContent("connected")
  );
  return harness;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  TestSocket.instances = [];
  window.history.replaceState({}, "", "/");
});

describe("project chat realtime notifications", () => {
  it("notifies for an inactive project and opens the exact project chat", async () => {
    const first = makeChat(chatOneId, projectOne);
    const second = makeChat(chatTwoId, projectTwo);
    const harness = await connectedHarness({
      projectIds: [projectOne, projectTwo],
      activeProjectId: projectOne,
      chatsByProject: { [projectOne]: [first], [projectTwo]: [second] }
    });

    await act(async () => {
      TestSocket.instances[1]!.emit(event(projectTwo, 1, chatTwoId));
    });
    await screen.findByText("New message in Build updates");
    await act(async () => {
      screen.getByRole("button", { name: "Open chat" }).click();
    });

    // These chats carry no branch_id (an older server): the default branch.
    expect(harness.navigateToChat).toHaveBeenCalledWith(
      projectTwo,
      chatTwoId,
      undefined
    );
  });

  it("silences the sender, observers, and the chat currently in view", async () => {
    const participant = makeChat(chatOneId, projectOne);
    const observer = makeChat(observerChatId, projectOne, false);
    const harness = await connectedHarness({
      chatsByProject: { [projectOne]: [participant, observer] }
    });
    const socket = TestSocket.instances[0]!;

    await act(async () => {
      socket.emit(
        event(projectOne, 1, chatOneId, "chat.message_created", {
          type: "human",
          id: userId
        })
      );
    });
    expect(harness.api.getChat).not.toHaveBeenCalled();

    await act(async () => {
      socket.emit(event(projectOne, 2, observerChatId));
    });
    await waitFor(() =>
      expect(harness.api.getChat).toHaveBeenCalledWith(observerChatId)
    );
    expect(
      screen.queryByRole("button", { name: "Open chat" })
    ).not.toBeInTheDocument();

    window.history.replaceState(
      {},
      "",
      `/projects/${projectOne}/messages?chat=${chatOneId}`
    );
    await act(async () => {
      socket.emit(event(projectOne, 3, chatOneId));
    });
    await waitFor(() =>
      expect(harness.api.getChat).toHaveBeenCalledWith(chatOneId)
    );
    expect(
      screen.queryByRole("button", { name: "Open chat" })
    ).not.toBeInTheDocument();
  });

  it("keeps an in-app mention notice when native notification delivery rejects", async () => {
    const chat = makeChat(chatOneId, projectOne);
    const notify = vi.fn().mockRejectedValue(new Error("permission denied"));
    const platform = desktopPlatform({
      notify,
      isBackgrounded: vi.fn(async () => true)
    });
    await connectedHarness({
      chatsByProject: { [projectOne]: [chat] },
      platform
    });

    await act(async () => {
      TestSocket.instances[0]!.emit(
        event(projectOne, 1, chatOneId, "chat.message_created", undefined, [
          { type: "human", id: userId }
        ])
      );
    });
    expect(await screen.findByText("Mentioned you")).toBeVisible();
    await waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(notify).toHaveBeenCalledWith({
      title: "You were mentioned",
      body: "Builder mentioned you.",
      destination: { kind: "chat", projectId: projectOne, chatId: chatOneId }
    });
    expect(screen.getByText("Mentioned you")).toBeVisible();
  });

  it("replaces the message notice with a handoff notice for the human recipient", async () => {
    const chat = makeChat(chatOneId, projectOne);
    const notify = vi.fn(async () => undefined);
    const platform = desktopPlatform({
      notify,
      isBackgrounded: vi.fn(async () => true)
    });
    await connectedHarness({
      chatsByProject: { [projectOne]: [chat] },
      platform
    });
    const socket = TestSocket.instances[0]!;
    await act(async () => {
      socket.emit(event(projectOne, 1, chatOneId));
    });
    await screen.findByText("New message in Build updates");
    // Handoffs to someone else never notify this viewer.
    await act(async () => {
      socket.emit({
        ...event(projectOne, 2, chatOneId, "chat.handoff_created"),
        affected_participant: { type: "agent", id: secondAgentId }
      });
    });
    await act(async () => {
      socket.emit({
        ...event(projectOne, 3, chatOneId, "chat.handoff_created"),
        affected_participant: { type: "human", id: userId }
      });
    });
    expect(await screen.findByText("Handoff from Builder")).toBeVisible();
    expect(screen.getByText("Builder handed work to you.")).toBeVisible();
    expect(
      screen.queryByText("New message in Build updates")
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Open chat" })).toHaveLength(
      1
    );
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(notify).toHaveBeenLastCalledWith({
      title: "Handoff from Builder",
      body: "Builder handed work to you.",
      destination: { kind: "chat", projectId: projectOne, chatId: chatOneId }
    });
  });

  it("does not re-notify a pending message when access is invalidated", async () => {
    const chat = makeChat(chatOneId, projectOne);
    let resolveChat!: (value: Chat) => void;
    let calls = 0;
    const getChat = vi.fn(async () => {
      calls += 1;
      if (calls === 2)
        return new Promise<Chat>((resolve) => (resolveChat = resolve));
      return chat;
    });
    const harness = await connectedHarness({
      chatsByProject: { [projectOne]: [chat] },
      getChat
    });
    const socket = TestSocket.instances[0]!;

    await act(async () => socket.emit(event(projectOne, 1, chatOneId)));
    await screen.findByText("New message in Build updates");
    harness.queryClient.setQueryData(messagingKeys.messages(chatOneId), {
      messages: [{ id: messageId, body_markdown: "private" }]
    });
    await act(async () => socket.emit(event(projectOne, 2, chatOneId)));
    await waitFor(() => expect(getChat).toHaveBeenCalledTimes(2));
    await act(async () =>
      socket.emit(
        event(projectOne, 3, chatOneId, "chat.access_invalidated", {
          type: "agent",
          id: agentId
        })
      )
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Open chat" })
      ).not.toBeInTheDocument()
    );
    expect(
      harness.queryClient.getQueryData(messagingKeys.messages(chatOneId))
    ).toBeUndefined();

    resolveChat(chat);
    await act(async () => Promise.resolve());
    expect(
      screen.queryByRole("button", { name: "Open chat" })
    ).not.toBeInTheDocument();
  });

  it("drops a native notification when access changes during the background check", async () => {
    const chat = makeChat(chatOneId, projectOne);
    const notify = vi.fn(async () => undefined);
    let resolveBackground!: (backgrounded: boolean) => void;
    const platform = desktopPlatform({
      notify,
      isBackgrounded: vi.fn(
        () => new Promise<boolean>((resolve) => (resolveBackground = resolve))
      )
    });
    const harness = await connectedHarness({
      chatsByProject: { [projectOne]: [chat] },
      platform
    });
    const socket = TestSocket.instances[0]!;

    await act(async () => socket.emit(event(projectOne, 1, chatOneId)));
    await waitFor(() => expect(platform.isBackgrounded).toHaveBeenCalledOnce());
    await act(async () =>
      socket.emit(event(projectOne, 2, chatOneId, "chat.access_invalidated"))
    );
    await act(async () => resolveBackground(true));

    expect(notify).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Open chat" })
    ).not.toBeInTheDocument();
    expect(
      harness.queryClient.getQueryData(messagingKeys.messages(chatOneId))
    ).toBeUndefined();
  });

  it("drops delayed chat notifications when the provider unmounts", async () => {
    const chat = makeChat(chatOneId, projectOne);
    const notify = vi.fn(async () => undefined);
    const platform = desktopPlatform({
      notify,
      isBackgrounded: vi.fn(async () => true)
    });
    let resolveChat!: (value: Chat) => void;
    const getChat = vi.fn(
      () => new Promise<Chat>((resolve) => (resolveChat = resolve))
    );
    const harness = await connectedHarness({
      chatsByProject: { [projectOne]: [chat] },
      platform,
      getChat
    });

    await act(async () =>
      TestSocket.instances[0]!.emit(event(projectOne, 1, chatOneId))
    );
    await waitFor(() => expect(getChat).toHaveBeenCalledOnce());
    harness.unmount();
    resolveChat(chat);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(notify).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Open chat" })
    ).not.toBeInTheDocument();
  });

  it("summarizes participant messages once after reconnect and stays silent for observer-only replay", async () => {
    const privateChat = makeChat(chatOneId, projectOne, true);
    const observerChat = makeChat(observerChatId, projectOne, false);
    let eventPage = 0;
    const inbox: InboxSummary = {
      unread_chats: [{ chat_id: chatOneId, unread_count: 2, mention_count: 1 }]
    };
    const notify = vi.fn(async () => undefined);
    const platform = desktopPlatform({
      notify,
      isBackgrounded: vi.fn(async () => true)
    });
    const harness = await connectedHarness({
      chatsByProject: { [projectOne]: [privateChat, observerChat] },
      inboxByProject: { [projectOne]: inbox },
      platform,
      listProjectEvents: async () => {
        eventPage += 1;
        return eventPage === 1
          ? { events: [], next_cursor: null }
          : {
              events: [
                {
                  id: 1,
                  type: "chat.message_created",
                  entity_id: chatOneId,
                  payload: {}
                }
              ],
              next_cursor: null
            };
      }
    });
    TestSocket.instances[0]!.close();
    await waitFor(() => expect(TestSocket.instances).toHaveLength(2), {
      timeout: 2_000
    });
    await act(async () => TestSocket.instances[1]!.open());
    expect(await screen.findByText("Mentioned you")).toBeVisible();
    await waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(notify).toHaveBeenCalledWith({
      title: "Unread mentions",
      body: "2 unread messages across 1 chat.",
      destination: { kind: "chat", projectId: projectOne, chatId: chatOneId }
    });

    // A duplicate live delivery of a replayed sequence cannot produce another notice.
    await act(async () =>
      TestSocket.instances[1]!.emit(event(projectOne, 1, chatOneId))
    );
    expect(notify).toHaveBeenCalledOnce();
    harness.unmount();

    let observerPage = 0;
    const observerInboxHarness = await connectedHarness({
      chatsByProject: { [projectOne]: [privateChat, observerChat] },
      inboxByProject: { [projectOne]: inbox },
      listProjectEvents: async () => {
        observerPage += 1;
        return observerPage === 1
          ? { events: [], next_cursor: null }
          : {
              events: [
                {
                  id: 1,
                  type: "chat.message_created",
                  entity_id: observerChatId,
                  payload: {}
                }
              ],
              next_cursor: null
            };
      }
    });
    observerInboxHarness.api.getProjectInbox.mockClear();
    TestSocket.instances[0]!.close();
    await waitFor(() => expect(TestSocket.instances).toHaveLength(2), {
      timeout: 2_000
    });
    await act(async () => TestSocket.instances[1]!.open());
    await waitFor(() =>
      expect(observerInboxHarness.api.listChats).toHaveBeenCalledTimes(2)
    );
    await waitFor(() =>
      expect(screen.getByTestId("realtime-status")).toHaveTextContent(
        "connected"
      )
    );
    expect(observerInboxHarness.api.getProjectInbox).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Open chat" })
    ).not.toBeInTheDocument();
  });

  it("stays silent when reconnect replay contains only the current user's messages", async () => {
    const chat = makeChat(chatOneId, projectOne);
    let eventPage = 0;
    const harness = await connectedHarness({
      chatsByProject: { [projectOne]: [chat] },
      inboxByProject: {
        [projectOne]: {
          unread_chats: [
            { chat_id: chatOneId, unread_count: 1, mention_count: 0 }
          ]
        }
      },
      listProjectEvents: async () => {
        eventPage += 1;
        return eventPage === 1
          ? { events: [], next_cursor: null }
          : {
              events: [
                {
                  id: 1,
                  type: "chat.message_created",
                  entity_id: chatOneId,
                  actor_user_id: userId,
                  actor_agent_id: null,
                  payload: {}
                }
              ],
              next_cursor: null
            };
      }
    });
    harness.api.getProjectInbox.mockClear();

    TestSocket.instances[0]!.close();
    await waitFor(() => expect(TestSocket.instances).toHaveLength(2), {
      timeout: 2_000
    });
    await act(async () => TestSocket.instances[1]!.open());
    await waitFor(() => expect(harness.api.listChats).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("realtime-status")).toHaveTextContent(
        "connected"
      )
    );

    expect(harness.api.getProjectInbox).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Open chat" })
    ).not.toBeInTheDocument();
  });

  it("drops a reconnect summary when chat access changes during inbox lookup", async () => {
    const chat = makeChat(chatOneId, projectOne);
    let eventPage = 0;
    const harness = await connectedHarness({
      chatsByProject: { [projectOne]: [chat] },
      listProjectEvents: async () => {
        eventPage += 1;
        return eventPage === 1
          ? { events: [], next_cursor: null }
          : {
              events: [
                {
                  id: 1,
                  type: "chat.message_created",
                  entity_id: chatOneId,
                  actor_user_id: null,
                  actor_agent_id: agentId,
                  payload: {}
                }
              ],
              next_cursor: null
            };
      }
    });
    let resolveInbox!: (value: InboxSummary) => void;
    harness.api.getProjectInbox.mockReturnValueOnce(
      new Promise((resolve) => (resolveInbox = resolve))
    );

    TestSocket.instances[0]!.close();
    await waitFor(() => expect(TestSocket.instances).toHaveLength(2), {
      timeout: 2_000
    });
    await act(async () => TestSocket.instances[1]!.open());
    await waitFor(() =>
      expect(harness.api.getProjectInbox).toHaveBeenCalledOnce()
    );
    await act(async () =>
      TestSocket.instances[1]!.emit(
        event(projectOne, 2, chatOneId, "chat.access_invalidated")
      )
    );
    await act(async () =>
      resolveInbox({
        unread_chats: [
          { chat_id: chatOneId, unread_count: 1, mention_count: 0 }
        ]
      })
    );

    expect(
      screen.queryByRole("button", { name: "Open chat" })
    ).not.toBeInTheDocument();
  });

  it("keeps distinct summaries for reconnect windows with equal counts", async () => {
    const firstChat = makeChat(chatOneId, projectOne);
    const secondChat = makeChat(chatTwoId, projectOne);
    let eventPage = 0;
    const harness = await connectedHarness({
      chatsByProject: { [projectOne]: [firstChat, secondChat] },
      listProjectEvents: async () => {
        eventPage += 1;
        return eventPage === 1
          ? { events: [], next_cursor: null }
          : {
              events: [
                {
                  id: eventPage - 1,
                  type: "chat.message_created",
                  entity_id: eventPage === 2 ? chatOneId : chatTwoId,
                  actor_user_id: null,
                  actor_agent_id: agentId,
                  payload: {}
                }
              ],
              next_cursor: null
            };
      }
    });
    harness.api.getProjectInbox
      .mockResolvedValueOnce({
        unread_chats: [
          { chat_id: chatOneId, unread_count: 1, mention_count: 0 }
        ]
      })
      .mockResolvedValueOnce({
        unread_chats: [
          { chat_id: chatTwoId, unread_count: 1, mention_count: 0 }
        ]
      });

    TestSocket.instances[0]!.close();
    await waitFor(() => expect(TestSocket.instances).toHaveLength(2), {
      timeout: 2_000
    });
    await act(async () => TestSocket.instances[1]!.open());
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Open chat" })).toHaveLength(
        1
      )
    );

    TestSocket.instances[1]!.close();
    await waitFor(() => expect(TestSocket.instances).toHaveLength(3), {
      timeout: 2_000
    });
    await act(async () => TestSocket.instances[2]!.open());
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Open chat" })).toHaveLength(
        2
      )
    );
    await act(async () =>
      screen.getAllByRole("button", { name: "Open chat" })[1]!.click()
    );

    expect(harness.navigateToChat).toHaveBeenLastCalledWith(
      projectOne,
      chatTwoId,
      undefined
    );
  });
});
