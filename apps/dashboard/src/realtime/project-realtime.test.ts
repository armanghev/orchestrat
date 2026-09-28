import { describe, expect, it, vi } from "vitest";
import type {
  ProjectEventsResponse,
  RealtimeEventEnvelope
} from "@orchestrat/protocol";
import {
  notificationForRealtimeEvent,
  ProjectRealtimeController,
  type SocketLike
} from "./project-realtime";
import { coordinationKeys } from "@/features/coordination/query-options";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const event = (sequence: number, event_type = "task.updated") =>
  ({
    project_id: projectId,
    sequence,
    event_type,
    entity_type: event_type.split(".")[0],
    entity_id: taskId
  }) as RealtimeEventEnvelope;

class FakeSocket implements SocketLike {
  readyState = 1;
  onopen: SocketLike["onopen"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  onmessage: SocketLike["onmessage"] = null;
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  });
  send = vi.fn();
}

function setup(
  socket = new FakeSocket(),
  socketFactory?: () => FakeSocket,
  platform?: { kind: "desktop"; notify: (value: unknown) => Promise<void> },
  isBackgrounded: () => boolean | Promise<boolean> = () => false
) {
  const invalidateQueries = vi.fn<
    (options: { queryKey: readonly unknown[] }) => Promise<void>
  >(() => Promise.resolve());
  const listProjectEvents = vi.fn<
    (
      projectId: string,
      query?: { after?: string; limit?: number }
    ) => Promise<ProjectEventsResponse>
  >(async () => ({ events: [], next_cursor: null }));
  const api = {
    createRealtimeTicket: vi.fn(async () => ({
      ticket: "a".repeat(32),
      expires_at: new Date().toISOString()
    })),
    getTask: vi.fn(async () => ({ status: "done", title: "Task" }) as never),
    realtimeSocketUrl: vi.fn(() => "wss://api.example/realtime"),
    listChats: vi.fn(async () => ({ chats: [] })),
    listProjectEvents
  };
  const queryClient = {
    invalidateQueries,
    getQueryData: vi.fn(() => undefined),
    setQueryData: vi.fn(),
    removeQueries: vi.fn()
  };
  const controller = new ProjectRealtimeController(
    api,
    queryClient as never,
    projectId,
    socketFactory ?? (() => socket),
    () => 0,
    platform,
    isBackgrounded
  );
  return { api, controller, invalidateQueries, queryClient, socket };
}

describe("ProjectRealtimeController", () => {
  it("selects only high-value notifications and deduplicates background events", async () => {
    const notify = vi.fn(async () => undefined);
    const f = setup(
      new FakeSocket(),
      undefined,
      { kind: "desktop", notify },
      () => true
    );
    f.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.socket.onopen?.(new Event("open"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.api.listProjectEvents.mockClear();
    f.api.listProjectEvents.mockResolvedValueOnce({
      events: [
        {
          id: 2,
          type: "claim.completed",
          payload: { task_id: taskId }
        } as never
      ],
      next_cursor: null
    });
    f.socket.onmessage?.({
      data: JSON.stringify(event(1, "run.failed"))
    } as MessageEvent);
    f.socket.onmessage?.({
      data: JSON.stringify(event(1, "run.failed"))
    } as MessageEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledTimes(1);
    f.socket.onmessage?.({
      data: JSON.stringify(event(2, "claim.completed"))
    } as MessageEvent);
    f.socket.onmessage?.({
      data: JSON.stringify(event(3, "task.moved"))
    } as MessageEvent);
    f.socket.onmessage?.({
      data: JSON.stringify(event(4, "task.comment_created"))
    } as MessageEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.api.getTask).toHaveBeenCalledWith(taskId);
    expect(f.api.listProjectEvents).toHaveBeenCalledTimes(1);
    expect(f.api.listProjectEvents).toHaveBeenCalledWith(projectId, {
      after: "1",
      limit: 1
    });
    expect(notify).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls).toEqual([
      [
        {
          title: "Agent run failed",
          body: "An agent run failed.",
          destination: { kind: "activity", projectId }
        }
      ],
      [
        {
          title: "Task completed",
          body: "An agent completed a task.",
          destination: { kind: "task", projectId, taskId }
        }
      ],
      [
        {
          title: "Task completed",
          body: "Task",
          destination: { kind: "task", projectId, taskId }
        }
      ]
    ]);
    const foregroundNotify = vi.fn(async () => undefined);
    const foreground = setup(
      new FakeSocket(),
      undefined,
      { kind: "desktop", notify: foregroundNotify },
      () => false
    );
    foreground.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    foreground.socket.onopen?.(new Event("open"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    foreground.api.listProjectEvents.mockClear();
    foreground.socket.onmessage?.({
      data: JSON.stringify(event(1, "claim.completed"))
    } as MessageEvent);
    await Promise.resolve();
    expect(foregroundNotify).not.toHaveBeenCalled();
    expect(foreground.api.listProjectEvents).not.toHaveBeenCalled();
    expect(
      notificationForRealtimeEvent(event(5, "task.comment_created"))
    ).toBeNull();
    expect(notificationForRealtimeEvent(event(6, "claim.completed"))).toEqual({
      title: "Task completed",
      body: "An agent completed a task.",
      destination: { kind: "activity", projectId }
    });
    expect(
      notificationForRealtimeEvent(event(7, "task.moved"), {
        status: "done",
        title: "Ship it"
      })
    ).toEqual({
      title: "Task completed",
      body: "Ship it",
      destination: { kind: "task", projectId, taskId }
    });
    const normalized = notificationForRealtimeEvent(event(8, "task.moved"), {
      status: "blocked",
      title: `Needs\ninput\u0000${"x".repeat(300)}`
    });
    expect(normalized?.body).not.toContain("\n");
    expect(normalized?.body).not.toContain(String.fromCharCode(0));
    expect([...(normalized?.body ?? "")]).toHaveLength(240);
  });

  it("falls back to activity when a claim event has no valid task destination", async () => {
    const notify = vi.fn(async () => undefined);
    const f = setup(
      new FakeSocket(),
      undefined,
      { kind: "desktop", notify },
      () => true
    );
    f.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.socket.onopen?.(new Event("open"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.api.listProjectEvents.mockResolvedValueOnce({
      events: [
        {
          id: 1,
          type: "claim.expired",
          payload: { task_id: "not-a-uuid" }
        } as never
      ],
      next_cursor: null
    });
    f.socket.onmessage?.({
      data: JSON.stringify(event(1, "claim.expired"))
    } as MessageEvent);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledWith({
      title: "Claim expired",
      body: "An agent claim expired.",
      destination: { kind: "activity", projectId }
    });
  });

  it("does not notify when the app gains focus during claim target lookup", async () => {
    const notify = vi.fn(async () => undefined);
    const isBackgrounded = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const f = setup(
      new FakeSocket(),
      undefined,
      { kind: "desktop", notify },
      isBackgrounded
    );
    f.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.socket.onopen?.(new Event("open"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.api.listProjectEvents.mockClear();

    let resolveLookup!: (value: ProjectEventsResponse) => void;
    f.api.listProjectEvents.mockReturnValueOnce(
      new Promise((resolve) => (resolveLookup = resolve))
    );
    f.socket.onmessage?.({
      data: JSON.stringify(event(1, "claim.completed"))
    } as MessageEvent);
    await vi.waitFor(() =>
      expect(f.api.listProjectEvents).toHaveBeenCalledOnce()
    );
    resolveLookup({
      events: [
        {
          id: 1,
          type: "claim.completed",
          payload: { task_id: taskId }
        } as never
      ],
      next_cursor: null
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(isBackgrounded).toHaveBeenCalledTimes(2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("does no notification work for noisy events and cancels pending work on stop", async () => {
    const notify = vi.fn(async () => undefined);
    let resolveBackground!: (backgrounded: boolean) => void;
    const isBackgrounded = vi
      .fn<() => boolean | Promise<boolean>>()
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => (resolveBackground = resolve))
      );
    const f = setup(
      new FakeSocket(),
      undefined,
      { kind: "desktop", notify },
      isBackgrounded
    );
    f.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.socket.onopen?.(new Event("open"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.api.listProjectEvents.mockClear();
    f.socket.onmessage?.({
      data: JSON.stringify(event(1, "task.comment_created"))
    } as MessageEvent);
    await Promise.resolve();
    expect(isBackgrounded).not.toHaveBeenCalled();

    f.socket.onmessage?.({
      data: JSON.stringify(event(2, "run.failed"))
    } as MessageEvent);
    await Promise.resolve();
    expect(isBackgrounded).toHaveBeenCalledOnce();
    f.controller.stop();
    resolveBackground(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notify).not.toHaveBeenCalled();
    expect(f.api.listProjectEvents).not.toHaveBeenCalled();
  });

  it("catches up before processing live events and ignores older sequences", async () => {
    const f = setup();
    f.api.listProjectEvents.mockResolvedValueOnce({
      events: [{ id: 4 } as never],
      next_cursor: null
    });
    f.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.socket.onopen?.(new Event("open"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.socket.onmessage?.({ data: JSON.stringify(event(3)) } as MessageEvent);
    f.socket.onmessage?.({ data: JSON.stringify(event(5)) } as MessageEvent);
    expect(f.controller.getStatus()).toBe("connected");
    const keys = f.invalidateQueries.mock.calls.map(
      ([options]) => options.queryKey
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        coordinationKeys.tasks(projectId),
        coordinationKeys.task("22222222-2222-4222-8222-222222222222"),
        coordinationKeys.events(projectId)
      ])
    );
  });

  it("paginates durable catch-up until the server cursor is exhausted", async () => {
    const f = setup();
    f.api.listProjectEvents
      .mockResolvedValueOnce({
        events: [{ id: 4 } as never],
        next_cursor: "4"
      })
      .mockResolvedValueOnce({
        events: [{ id: 7 } as never],
        next_cursor: null
      });
    f.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.socket.onopen?.(new Event("open"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      f.api.listProjectEvents.mock.calls.map(([, query]) => query?.after)
    ).toEqual([undefined, "4"]);
  });

  it("keeps live events buffered until catch-up succeeds", async () => {
    const f = setup();
    let resolve!: (value: ProjectEventsResponse) => void;
    f.api.listProjectEvents.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    f.controller.start();
    await new Promise((done) => setTimeout(done, 0));
    f.socket.onopen?.(new Event("open"));
    await new Promise((done) => setTimeout(done, 0));
    f.socket.onmessage?.({ data: JSON.stringify(event(1)) } as MessageEvent);
    expect(f.controller.getStatus()).toBe("connecting");
    expect(f.invalidateQueries).not.toHaveBeenCalled();
    resolve({ events: [], next_cursor: null });
    await new Promise((done) => setTimeout(done, 0));
    expect(f.controller.getStatus()).toBe("connected");
    expect(f.invalidateQueries).toHaveBeenCalled();
  });

  it("does not cache refreshed chats after the controller stops", async () => {
    const f = setup();
    let resolveChats!: (
      value: Awaited<ReturnType<typeof f.api.listChats>>
    ) => void;
    f.api.listChats.mockReturnValueOnce(
      new Promise((done) => {
        resolveChats = done;
      })
    );
    f.controller.start();
    await new Promise((done) => setTimeout(done, 0));
    f.socket.onopen?.(new Event("open"));
    await new Promise((done) => setTimeout(done, 0));
    expect(f.api.listChats).toHaveBeenCalledOnce();

    f.controller.stop();
    resolveChats({ chats: [] });
    await new Promise((done) => setTimeout(done, 0));

    expect(f.queryClient.setQueryData).not.toHaveBeenCalled();
    expect(f.controller.getStatus()).toBe("disconnected");
  });

  it("closes and reconnects when durable catch-up fails", async () => {
    const f = setup();
    f.api.listProjectEvents.mockRejectedValueOnce(new Error("offline"));
    f.controller.start();
    await new Promise((done) => setTimeout(done, 0));
    f.socket.onopen?.(new Event("open"));
    await new Promise((done) => setTimeout(done, 0));
    expect(f.socket.close).toHaveBeenCalled();
    expect(f.controller.getStatus()).toBe("disconnected");
    expect(f.api.createRealtimeTicket).toHaveBeenCalledTimes(1);
  });

  it("does not let stale catch-up release the current socket", async () => {
    vi.useFakeTimers();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const f = setup(
      first,
      (() => {
        let index = 0;
        return () => (index++ === 0 ? first : second);
      })()
    );
    let resolveFirst!: (value: ProjectEventsResponse) => void;
    let resolveSecond!: (value: ProjectEventsResponse) => void;
    f.api.listProjectEvents
      .mockReturnValueOnce(new Promise((done) => (resolveFirst = done)))
      .mockReturnValueOnce(new Promise((done) => (resolveSecond = done)));
    f.controller.start();
    await Promise.resolve();
    first.onopen?.(new Event("open"));
    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    second.onopen?.(new Event("open"));
    second.onmessage?.({ data: JSON.stringify(event(1)) } as MessageEvent);
    resolveFirst({ events: [], next_cursor: null });
    await Promise.resolve();
    expect(f.controller.getStatus()).toBe("connecting");
    expect(f.invalidateQueries).not.toHaveBeenCalled();
    resolveSecond({ events: [], next_cursor: null });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.controller.getStatus()).toBe("connected");
    expect(f.invalidateQueries).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("conservatively invalidates project queries for malformed or unknown events", async () => {
    const f = setup();
    f.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.socket.onopen?.(new Event("open"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.invalidateQueries.mockClear();
    f.socket.onmessage?.({ data: "not-json" } as MessageEvent);
    f.socket.onmessage?.({
      data: JSON.stringify(event(1, "mystery.updated"))
    } as MessageEvent);
    const keys = f.invalidateQueries.mock.calls.map(
      ([options]) => options.queryKey
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        coordinationKeys.tasks(projectId),
        coordinationKeys.agents(projectId),
        coordinationKeys.presence(projectId),
        coordinationKeys.events(projectId),
        coordinationKeys.documents(projectId)
      ])
    );
  });

  it("invalidates document list, detail, revisions, attachments, and events from entity_id", async () => {
    const f = setup();
    f.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.socket.onopen?.(new Event("open"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.invalidateQueries.mockClear();
    f.socket.onmessage?.({
      data: JSON.stringify(event(1, "document.updated"))
    } as MessageEvent);
    const keys = f.invalidateQueries.mock.calls.map(
      ([options]) => options.queryKey
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        coordinationKeys.documents(projectId),
        coordinationKeys.document("22222222-2222-4222-8222-222222222222"),
        coordinationKeys.revisions("22222222-2222-4222-8222-222222222222"),
        coordinationKeys.attachments("22222222-2222-4222-8222-222222222222"),
        coordinationKeys.events(projectId)
      ])
    );
  });

  it("targets document caches for lifecycle events outside the known event list", async () => {
    const f = setup();
    f.controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.socket.onopen?.(new Event("open"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.invalidateQueries.mockClear();
    f.socket.onmessage?.({
      data: JSON.stringify(event(1, "document.archived"))
    } as MessageEvent);
    const keys = f.invalidateQueries.mock.calls.map(
      ([options]) => options.queryKey
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        coordinationKeys.documents(projectId),
        coordinationKeys.document("22222222-2222-4222-8222-222222222222"),
        coordinationKeys.revisions("22222222-2222-4222-8222-222222222222"),
        coordinationKeys.attachments("22222222-2222-4222-8222-222222222222"),
        coordinationKeys.events(projectId)
      ])
    );
  });

  it("uses a fresh ticket after a bounded reconnect", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.controller.start();
    await Promise.resolve();
    f.socket.onopen?.(new Event("open"));
    await Promise.resolve();
    f.socket.onclose?.(new CloseEvent("close"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.api.createRealtimeTicket).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
