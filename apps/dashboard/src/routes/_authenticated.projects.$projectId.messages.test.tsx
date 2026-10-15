import {
  act,
  fireEvent,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, type RequestHandler } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage, MessageCandidate } from "@orchestrat/protocol";
import { FakeAuthClient } from "@/test/fake-auth-client";
import { messagingKeys } from "@/features/messaging/query-options";
import { handlers } from "@/test/handlers";
import { renderDashboardRoute } from "@/test/render";

const apiUrl = "http://localhost:8801/api/v1";
const projectId = "00000000-0000-4000-8000-000000000003";
const selfId = "00000000-0000-4000-8000-000000000004";
const aliceId = "00000000-0000-4000-8000-000000000011";
const bobId = "00000000-0000-4000-8000-000000000012";
const chatAliceId = "00000000-0000-4000-8000-000000000021";
const chatBobId = "00000000-0000-4000-8000-000000000022";
const timestamp = "2026-09-24T00:00:00.000Z";

const self = candidate({ id: selfId, name: "Test User" });
const alice = candidate({ id: aliceId, name: "Alice" });
const bob = candidate({ id: bobId, name: "Bob" });

class Auth extends FakeAuthClient {}

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

function candidate(
  overrides: Partial<MessageCandidate> & Pick<MessageCandidate, "id" | "name">
): MessageCandidate {
  return {
    type: "human",
    avatar_url: null,
    ...overrides
  };
}

function chat(overrides: Partial<Chat> = {}): Chat {
  return {
    id: chatAliceId,
    project_id: projectId,
    kind: "direct",
    name: null,
    has_human: true,
    creator: { type: "human", id: selfId },
    participants: [self, alice],
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

function message(
  chatId: string,
  sequence: number,
  body = `Message ${sequence}`
): ChatMessage {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    chat_id: chatId,
    project_id: projectId,
    sequence,
    author: { type: "human", id: aliceId, name: "Alice" },
    body_markdown: body,
    mentions: [],
    documents: [],
    created_at: timestamp
  };
}

function page(messages: ChatMessage[], nextBefore: number | null = null) {
  return {
    messages,
    has_more: nextBefore !== null,
    next_after: null,
    next_before: nextBefore
  };
}

function range(chatId: string, start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) =>
    message(chatId, start + index)
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function routeHandlers({
  chats,
  messages,
  candidates = [alice, bob],
  extra = []
}: {
  chats: Chat[];
  messages: (chatId: string, request: Request) => Response | Promise<Response>;
  candidates?: MessageCandidate[] | (() => MessageCandidate[]);
  extra?: RequestHandler[];
}) {
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
    http.get(`${apiUrl}/projects/${projectId}/chats`, () =>
      HttpResponse.json({ chats })
    ),
    http.get(`${apiUrl}/projects/${projectId}/message-candidates`, () =>
      HttpResponse.json({
        candidates: typeof candidates === "function" ? candidates() : candidates
      })
    ),
    http.get(`${apiUrl}/projects/${projectId}/inbox`, () =>
      HttpResponse.json({ unread_chats: [] })
    ),
    http.post(`${apiUrl}/realtime/tickets`, () =>
      HttpResponse.json({ ticket: "a".repeat(32), expires_at: timestamp })
    ),
    http.get(`${apiUrl}/chats/:chatId/messages`, ({ params, request }) =>
      messages(String(params.chatId), request)
    ),
    ...extra,
    ...handlers
  ];
}

async function renderMessages({
  chats,
  messages,
  candidates,
  extra,
  selectedChatId
}: {
  chats: Chat[];
  messages: (chatId: string, request: Request) => Response | Promise<Response>;
  candidates?: MessageCandidate[] | (() => MessageCandidate[]);
  extra?: RequestHandler[];
  selectedChatId?: string;
}) {
  return renderDashboardRoute({
    path: `/projects/${projectId}/messages${selectedChatId ? `?chat=${selectedChatId}` : ""}`,
    auth: new Auth({ status: "signedIn", identityKey: "user" }),
    platform: platform(),
    handlers: routeHandlers({ chats, messages, candidates, extra })
  });
}

function chatButton(name: string) {
  return within(screen.getByLabelText("Conversations")).getByRole("button", {
    name: new RegExp(name)
  });
}

function composer() {
  return screen.getByRole("textbox", { name: "Write a message" });
}

function renderedSequences() {
  return Array.from(
    screen
      .getByLabelText("Message history")
      .querySelectorAll("[data-sequence]"),
    (element) => Number((element as HTMLElement).dataset.sequence)
  );
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("project messages route", () => {
  it("creates a group with more than one selected project participant", async () => {
    const chats: Chat[] = [];
    const created = chat({
      id: "00000000-0000-4000-8000-000000000023",
      kind: "group",
      name: "Release planning",
      participants: [self, alice, bob],
      can_manage: true
    });
    let received: unknown;
    await renderMessages({
      chats,
      messages: () => HttpResponse.json(page([])),
      extra: [
        http.post(
          `${apiUrl}/projects/${projectId}/chats`,
          async ({ request }) => {
            received = await request.json();
            chats.push(created);
            return HttpResponse.json(created, { status: 201 });
          }
        )
      ]
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "New message" }));
    await user.click(screen.getByRole("button", { name: /Alice.*Human/ }));
    expect(
      screen.getByRole("button", { name: "Start conversation" })
    ).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /Bob.*Human/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Group name" }),
      "Release planning"
    );
    await user.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() =>
      expect(received).toEqual({
        kind: "group",
        name: "Release planning",
        participants: [
          { type: "human", id: aliceId },
          { type: "human", id: bobId }
        ]
      })
    );
  });

  it("creates a human-agent direct message with typed participant identities", async () => {
    const agent = candidate({
      id: "00000000-0000-4000-8000-000000000013",
      name: "Build Agent",
      type: "agent"
    });
    let received: unknown;
    await renderMessages({
      chats: [],
      candidates: [alice, agent],
      messages: () => HttpResponse.json(page([])),
      extra: [
        http.post(
          `${apiUrl}/projects/${projectId}/chats`,
          async ({ request }) => {
            received = await request.json();
            return HttpResponse.json(
              chat({
                id: chatBobId,
                participants: [self, agent]
              }),
              { status: 201 }
            );
          }
        )
      ]
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "New message" }));
    await user.click(
      screen.getByRole("button", { name: /Build Agent.*Agent/ })
    );
    await user.click(
      screen.getByRole("button", { name: "Start conversation" })
    );

    await waitFor(() =>
      expect(received).toEqual({
        kind: "direct",
        participants: [{ type: "agent", id: agent.id }]
      })
    );
  });

  it("refreshes creation and member pickers after project membership changes", async () => {
    const charlie = candidate({
      id: "00000000-0000-4000-8000-000000000013",
      name: "Charlie"
    });
    const group = chat({
      kind: "group",
      name: "Release planning",
      participants: [self, bob],
      can_manage: true
    });
    let projectCandidates: MessageCandidate[] = [];
    await renderMessages({
      chats: [group],
      candidates: () => projectCandidates,
      selectedChatId: group.id,
      messages: () => HttpResponse.json(page([]))
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "New message" }));
    expect(
      await screen.findByText("No matching project members.")
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close new message" }));

    projectCandidates = [alice];
    await user.click(screen.getByRole("button", { name: "New message" }));
    expect(
      await screen.findByRole("button", { name: /Alice.*Human/ })
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close new message" }));

    projectCandidates = [charlie];
    await user.click(screen.getByRole("button", { name: "Members, 2" }));
    await user.type(
      await screen.findByRole("textbox", {
        name: "Find project member to add"
      }),
      "Charlie"
    );
    expect(
      await screen.findByRole("button", { name: "Add Charlie" })
    ).toBeVisible();
  });

  it("sends typed group mentions for current members only", async () => {
    const agent = candidate({
      id: "00000000-0000-4000-8000-000000000013",
      name: "Build Agent",
      type: "agent"
    });
    const group = chat({
      kind: "group",
      name: "Release planning",
      participants: [self, alice, agent]
    });
    let received: unknown;
    await renderMessages({
      chats: [group],
      candidates: [alice, bob, agent],
      selectedChatId: group.id,
      messages: () => HttpResponse.json(page([])),
      extra: [
        http.post(
          `${apiUrl}/chats/${group.id}/messages`,
          async ({ request }) => {
            received = await request.json();
            return HttpResponse.json(message(group.id, 1));
          }
        )
      ]
    });
    const user = userEvent.setup();

    await user.type(
      await screen.findByRole("textbox", { name: "Write a message" }),
      "Hello"
    );
    await user.click(screen.getByRole("button", { name: "Mention" }));
    expect(
      screen.queryByRole("button", { name: /Bob/ })
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Build Agent.*Agent/ })
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(received).toEqual({
        body_markdown: "Hello @Build_Agent ",
        mentions: [{ type: "agent", id: agent.id }],
        document_ids: []
      })
    );
  });

  it("keeps cached histories isolated when switching conversations", async () => {
    const aliceChat = chat({ id: chatAliceId, participants: [self, alice] });
    const bobChat = chat({
      id: chatBobId,
      participants: [self, bob],
      updated_at: "2026-09-24T00:01:00.000Z"
    });
    await renderMessages({
      chats: [aliceChat, bobChat],
      selectedChatId: chatAliceId,
      messages: (chatId) =>
        HttpResponse.json(
          page(
            chatId === chatAliceId
              ? [message(chatId, 1, "Alice history")]
              : [message(chatId, 1, "Bob history")]
          )
        )
    });
    const user = userEvent.setup();

    expect(await screen.findByText("Alice history")).toBeVisible();
    await user.click(chatButton("Bob"));
    expect(await screen.findByText("Bob history")).toBeVisible();
    expect(screen.queryByText("Alice history")).not.toBeInTheDocument();
    await user.click(chatButton("Alice"));
    expect(await screen.findByText("Alice history")).toBeVisible();
    expect(screen.queryByText("Bob history")).not.toBeInTheDocument();
  });

  it("keeps the search after opening an agent conversation as an observer", async () => {
    const buildAgent = candidate({
      id: "00000000-0000-4000-8000-000000000013",
      name: "Build Agent",
      type: "agent"
    });
    const reviewAgent = candidate({
      id: "00000000-0000-4000-8000-000000000014",
      name: "Review Agent",
      type: "agent"
    });
    const observerChat = chat({
      id: chatBobId,
      kind: "direct",
      name: null,
      has_human: false,
      participants: [buildAgent, reviewAgent],
      is_participant: false,
      can_join: false
    });
    await renderMessages({
      chats: [chat(), observerChat],
      messages: (chatId) => HttpResponse.json(page([message(chatId, 1)]))
    });
    const user = userEvent.setup();

    await screen.findByRole("button", { name: /Build Agent/ });
    await user.type(
      screen.getByRole("searchbox", { name: "Search conversations" }),
      "Build"
    );
    await user.click(
      within(screen.getByLabelText("Conversations")).getByRole("button", {
        name: /Build Agent/
      })
    );

    expect(
      await screen.findByRole("heading", { name: "Build Agent" })
    ).toBeVisible();
    expect(
      within(screen.getByLabelText("Conversations")).getByRole("heading", {
        name: /Agent conversations/
      })
    ).toBeVisible();
    expect(
      screen.getByText("Read-only observer", { exact: false })
    ).toBeVisible();
    expect(
      screen.getByRole("searchbox", { name: "Search conversations" })
    ).toHaveValue("Build");
  });

  it("evicts cached history when a selected conversation is no longer accessible", async () => {
    const aliceChat = chat({ id: chatAliceId, participants: [self, alice] });
    const chats = [aliceChat];
    let requests = 0;
    const rendered = await renderMessages({
      chats,
      selectedChatId: chatAliceId,
      messages: () => {
        requests += 1;
        if (requests === 1)
          return HttpResponse.json(
            page([message(chatAliceId, 1, "Cached private history")])
          );
        chats.splice(0);
        return HttpResponse.json(
          {
            error: {
              code: "PERMISSION_DENIED",
              message: "You no longer have access to this conversation.",
              details: {},
              request_id: "messages-revoked"
            }
          },
          { status: 403 }
        );
      }
    });

    expect(await screen.findByText("Cached private history")).toBeVisible();
    await act(async () => {
      await rendered.queryClient.invalidateQueries({
        queryKey: messagingKeys.messages(chatAliceId)
      });
    });

    await waitFor(() =>
      expect(
        screen.queryByText("Cached private history")
      ).not.toBeInTheDocument()
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You no longer have access to this conversation."
    );
  });

  it("retries a failed send with the same idempotency key and draft after navigation", async () => {
    const aliceChat = chat({ id: chatAliceId, participants: [self, alice] });
    const bobChat = chat({ id: chatBobId, participants: [self, bob] });
    const sent: Array<{ body: unknown; key: string | null }> = [];
    await renderMessages({
      chats: [aliceChat, bobChat],
      selectedChatId: chatAliceId,
      messages: () => HttpResponse.json(page([])),
      extra: [
        http.post(
          `${apiUrl}/chats/${chatAliceId}/messages`,
          async ({ request }) => {
            sent.push({
              body: await request.json(),
              key: request.headers.get("Idempotency-Key")
            });
            return sent.length === 1
              ? HttpResponse.json(
                  { error: { message: "temporary" } },
                  { status: 500 }
                )
              : HttpResponse.json(message(chatAliceId, 1, "Retry draft"));
          }
        )
      ]
    });
    const user = userEvent.setup();

    await user.type(
      await screen.findByRole("textbox", { name: "Write a message" }),
      "Retry draft"
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeVisible();
    await user.click(chatButton("Bob"));
    await screen.findByRole("textbox", { name: "Write a message" });
    await user.click(chatButton("Alice"));
    await waitFor(() => expect(composer()).toHaveValue("Retry draft"));
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toEqual({
      key: sent[1]?.key,
      body: { body_markdown: "Retry draft", mentions: [], document_ids: [] }
    });
    expect(sent[0]?.key).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("does not clear a newer draft when an old conversation send succeeds late", async () => {
    const response = deferred<Response>();
    const aliceChat = chat({ id: chatAliceId, participants: [self, alice] });
    const bobChat = chat({ id: chatBobId, participants: [self, bob] });
    await renderMessages({
      chats: [aliceChat, bobChat],
      selectedChatId: chatAliceId,
      messages: () => HttpResponse.json(page([])),
      extra: [
        http.post(
          `${apiUrl}/chats/${chatAliceId}/messages`,
          () => response.promise
        )
      ]
    });
    const user = userEvent.setup();

    await user.type(
      await screen.findByRole("textbox", { name: "Write a message" }),
      "Old chat draft"
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(chatButton("Bob"));
    await user.type(
      await screen.findByRole("textbox", { name: "Write a message" }),
      "New chat draft"
    );
    await act(async () => {
      response.resolve(
        HttpResponse.json(message(chatAliceId, 1, "Old chat draft"))
      );
    });

    await waitFor(() => expect(composer()).toHaveValue("New chat draft"));
  });

  it("keeps an edited draft when its earlier send completes", async () => {
    const response = deferred<Response>();
    const aliceChat = chat({ id: chatAliceId, participants: [self, alice] });
    await renderMessages({
      chats: [aliceChat],
      selectedChatId: chatAliceId,
      messages: () => HttpResponse.json(page([])),
      extra: [
        http.post(
          `${apiUrl}/chats/${chatAliceId}/messages`,
          () => response.promise
        )
      ]
    });
    const user = userEvent.setup();

    await user.type(
      await screen.findByRole("textbox", { name: "Write a message" }),
      "Original draft"
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.clear(composer());
    await user.type(composer(), "Edited draft");
    await act(async () => {
      response.resolve(
        HttpResponse.json(message(chatAliceId, 1, "Original draft"))
      );
    });

    await waitFor(() => expect(composer()).toHaveValue("Edited draft"));
  });

  it("backfills every intermediate observer message when a latest-page refetch skips a gap", async () => {
    const aliceChat = chat({
      id: chatAliceId,
      participants: [self, alice],
      is_participant: false,
      last_sequence: 250
    });
    let latestRequests = 0;
    const rendered = await renderMessages({
      chats: [aliceChat],
      selectedChatId: chatAliceId,
      messages: (chatId, request) => {
        const query = new URL(request.url).searchParams;
        if (query.get("after") === "150")
          return HttpResponse.json(page(range(chatId, 151, 250)));
        latestRequests += 1;
        return HttpResponse.json(
          page(
            latestRequests === 1
              ? range(chatId, 101, 150)
              : range(chatId, 201, 250),
            latestRequests === 1 ? 101 : 201
          )
        );
      }
    });

    await screen.findByText("Message 150");
    await act(async () => {
      await rendered.queryClient.invalidateQueries({
        queryKey: messagingKeys.messages(chatAliceId)
      });
    });

    await waitFor(() =>
      expect(renderedSequences()).toEqual(
        Array.from({ length: 150 }, (_, index) => index + 101)
      )
    );
  });

  it("lets the user retry a failed history backfill", async () => {
    const aliceChat = chat({
      id: chatAliceId,
      participants: [self, alice],
      last_sequence: 3
    });
    let backfillAttempts = 0;
    await renderMessages({
      chats: [aliceChat],
      selectedChatId: chatAliceId,
      messages: (chatId, request) => {
        if (new URL(request.url).searchParams.get("after") !== "2")
          return HttpResponse.json(page([message(chatId, 2)]));
        backfillAttempts += 1;
        return backfillAttempts === 1
          ? HttpResponse.json(
              { error: { message: "temporary" } },
              { status: 500 }
            )
          : HttpResponse.json(page([message(chatId, 3)]));
      }
    });

    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Retry sync" }));

    expect(await screen.findByText("Message 3")).toBeVisible();
    expect(backfillAttempts).toBe(2);
  });

  it("keeps older history exhausted after a newer-page refetch", async () => {
    const aliceChat = chat({
      id: chatAliceId,
      participants: [self, alice],
      last_sequence: 150
    });
    let latestRequests = 0;
    const rendered = await renderMessages({
      chats: [aliceChat],
      selectedChatId: chatAliceId,
      messages: (chatId, request) => {
        const query = new URL(request.url).searchParams;
        if (query.get("before") === "51")
          return HttpResponse.json(page(range(chatId, 1, 50)));
        latestRequests += 1;
        return HttpResponse.json(
          page(
            latestRequests === 1
              ? range(chatId, 51, 100)
              : range(chatId, 101, 150),
            latestRequests === 1 ? 51 : 101
          )
        );
      }
    });
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: "Load older messages" })
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Load older messages" })
      ).not.toBeInTheDocument()
    );
    await act(async () => {
      await rendered.queryClient.invalidateQueries({
        queryKey: messagingKeys.messages(chatAliceId)
      });
    });

    await screen.findByText("Message 150");
    expect(
      screen.queryByRole("button", { name: "Load older messages" })
    ).not.toBeInTheDocument();
  });

  it("preserves the visible scroll position when older messages are loaded", async () => {
    const aliceChat = chat({
      id: chatAliceId,
      participants: [self, alice],
      last_sequence: 60
    });
    await renderMessages({
      chats: [aliceChat],
      selectedChatId: chatAliceId,
      messages: (chatId, request) =>
        new URL(request.url).searchParams.has("before")
          ? HttpResponse.json(page(range(chatId, 1, 50)))
          : HttpResponse.json(page(range(chatId, 51, 60), 51))
    });
    const user = userEvent.setup();
    const history = await screen.findByLabelText("Message history");

    await screen.findByText("Message 60");
    Object.defineProperties(history, {
      clientHeight: { configurable: true, value: 50 },
      scrollHeight: {
        configurable: true,
        get: () => history.querySelectorAll("[data-sequence]").length * 20
      }
    });
    (history as HTMLElement).scrollTop = 50;
    fireEvent.scroll(history);

    await user.click(
      screen.getByRole("button", { name: "Load older messages" })
    );
    await screen.findByText("Message 1");
    await waitFor(() => expect((history as HTMLElement).scrollTop).toBe(1050));
  });

  it("acknowledges visible messages monotonically when observer events arrive out of order", async () => {
    const observers: Array<{
      targets: Map<number, Element>;
      trigger: (sequence: number) => void;
    }> = [];
    class TestIntersectionObserver {
      readonly targets = new Map<number, Element>();

      constructor(private readonly callback: IntersectionObserverCallback) {
        observers.push(this);
      }

      observe(target: Element) {
        this.targets.set(
          Number((target as HTMLElement).dataset.sequence),
          target
        );
      }

      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }

      trigger = (sequence: number) => {
        const target = this.targets.get(sequence);
        if (target)
          this.callback(
            [{ target, isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver
          );
      };
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

    const aliceChat = chat({
      id: chatAliceId,
      participants: [self, alice],
      last_sequence: 2,
      unread_count: 2
    });
    const acknowledged: string[] = [];
    await renderMessages({
      chats: [aliceChat],
      selectedChatId: chatAliceId,
      messages: (chatId, request) =>
        new URL(request.url).searchParams.has("after")
          ? HttpResponse.json(page(range(chatId, 1, 2)))
          : HttpResponse.json(page(range(chatId, 1, 2))),
      extra: [
        http.post(
          `${apiUrl}/chats/${chatAliceId}/read`,
          async ({ request }) => {
            const body = (await request.json()) as {
              through_message_id: string;
            };
            acknowledged.push(body.through_message_id);
            return HttpResponse.json({ last_read_sequence: 2 });
          }
        )
      ]
    });

    await screen.findByText("Message 2");
    await waitFor(() => expect(observers[0]?.targets.size).toBe(2));
    observers[0]?.trigger(2);
    await waitFor(() =>
      expect(acknowledged).toEqual([message(chatAliceId, 2).id])
    );
    observers[0]?.trigger(1);
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(acknowledged).toEqual([message(chatAliceId, 2).id]);
  });
});
