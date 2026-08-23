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
const event = (sequence: number, event_type = "task.updated") =>
  ({
    project_id: projectId,
    sequence,
    event_type,
    entity_type: event_type.split(".")[0],
    entity_id: "22222222-2222-4222-8222-222222222222"
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
  isBackgrounded = () => false
) {
  const invalidateQueries = vi.fn<
    (options: { queryKey: readonly unknown[] }) => Promise<void>
  >(() => Promise.resolve());
  const listProjectEvents = vi.fn<
    (
      projectId: string,
      query?: { after?: string }
    ) => Promise<ProjectEventsResponse>
  >(async () => ({ events: [], next_cursor: null }));
  const api = {
    createRealtimeTicket: vi.fn(async () => ({
      ticket: "a".repeat(32),
      expires_at: new Date().toISOString()
    })),
    getTask: vi.fn(async () => ({ status: "done", title: "Task" }) as never),
    realtimeSocketUrl: vi.fn(() => "wss://api.example/realtime"),
    listProjectEvents
  };
  const controller = new ProjectRealtimeController(
    api,
    { invalidateQueries } as never,
    projectId,
    socketFactory ?? (() => socket),
    () => 0,
    platform,
    isBackgrounded
  );
  return { api, controller, invalidateQueries, socket };
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
    expect(f.api.getTask).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222"
    );
    expect(notify).toHaveBeenCalledTimes(3);
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
    foreground.socket.onmessage?.({
      data: JSON.stringify(event(1, "claim.completed"))
    } as MessageEvent);
    await Promise.resolve();
    expect(foregroundNotify).not.toHaveBeenCalled();
    expect(
      notificationForRealtimeEvent(event(5, "task.comment_created"))
    ).toBeNull();
    expect(notificationForRealtimeEvent(event(6, "claim.completed"))).toEqual({
      title: "Task completed",
      body: "An agent completed a task."
    });
    expect(
      notificationForRealtimeEvent(event(7, "task.moved"), {
        status: "done",
        title: "Ship it"
      })
    ).toEqual({
      title: "Task completed",
      body: "Ship it"
    });
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

  it("invalidates document list, detail, revisions, and events from entity_id", async () => {
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
