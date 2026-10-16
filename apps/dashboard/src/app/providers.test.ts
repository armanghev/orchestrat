import { describe, expect, it, vi } from "vitest";
import type { AuthSnapshot } from "@/features/auth/auth-client";
import { createDashboardQueryClient } from "./query-client";
import {
  watchAuthSessionBoundaries,
  watchNotificationActions
} from "./providers";

function authFixture(initial: AuthSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    auth: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    },
    emit(next: AuthSnapshot) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    }
  };
}

describe("watchAuthSessionBoundaries", () => {
  it("clears user-scoped cache when signed-in identity changes without exposing stale A data", () => {
    const f = authFixture({ status: "signedIn", identityKey: "account-a" });
    const queryClient = createDashboardQueryClient();
    queryClient.setQueryData(["private", "projects"], ["account-a-project"]);
    const navigate = vi.fn();
    const stop = watchAuthSessionBoundaries(f.auth, queryClient, { navigate });
    f.emit({ status: "signedIn", identityKey: "account-b" });
    expect(queryClient.getQueryData(["private", "projects"])).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith({ to: "/", replace: true });
    stop();
  });

  it("does not clear cache for a same-user token refresh", () => {
    const f = authFixture({ status: "signedIn", identityKey: "same-user" });
    const queryClient = createDashboardQueryClient();
    queryClient.setQueryData(["private"], "retained");
    const stop = watchAuthSessionBoundaries(f.auth, queryClient, {
      navigate: vi.fn()
    });
    f.emit({ status: "signedIn", identityKey: "same-user" });
    expect(queryClient.getQueryData(["private"])).toBe("retained");
    stop();
  });

  it("clears cache and navigates root on sign-out even after an intermediate loading state", () => {
    const f = authFixture({ status: "signedIn", identityKey: "account-a" });
    const queryClient = createDashboardQueryClient();
    queryClient.setQueryData(["private"], "account-a-data");
    const navigate = vi.fn();
    const stop = watchAuthSessionBoundaries(f.auth, queryClient, { navigate });
    f.emit({ status: "loading" });
    f.emit({ status: "signedOut" });
    expect(queryClient.getQueryData(["private"])).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
    stop();
  });
});

describe("watchNotificationActions", () => {
  it("routes task and activity destinations across projects", async () => {
    let handle:
      | ((
          destination:
            | {
                kind: "task";
                projectId: string;
                branchId?: string;
                taskId: string;
              }
            | { kind: "activity"; projectId: string; branchId?: string }
            | {
                kind: "chat";
                projectId: string;
                branchId?: string;
                chatId: string;
              }
        ) => void)
      | undefined;
    const unlisten = vi.fn();
    const platform = {
      onNotificationAction: vi.fn(async (listener) => {
        handle = listener;
        return unlisten;
      })
    };
    const navigate = vi.fn();
    const stop = watchNotificationActions(platform, { navigate });
    await Promise.resolve();

    handle?.({
      kind: "task",
      projectId: "11111111-1111-4111-8111-111111111111",
      taskId: "22222222-2222-4222-8222-222222222222"
    });
    handle?.({
      kind: "activity",
      projectId: "33333333-3333-4333-8333-333333333333"
    });
    handle?.({
      kind: "chat",
      projectId: "44444444-4444-4444-8444-444444444444",
      chatId: "55555555-5555-4555-8555-555555555555"
    });
    handle?.({
      kind: "task",
      projectId: "11111111-1111-4111-8111-111111111111",
      branchId: "66666666-6666-4666-8666-666666666666",
      taskId: "22222222-2222-4222-8222-222222222222"
    });

    expect(navigate.mock.calls).toEqual([
      [
        {
          to: "/projects/$projectId/tasks",
          params: { projectId: "11111111-1111-4111-8111-111111111111" },
          search: { task: "22222222-2222-4222-8222-222222222222" }
        }
      ],
      [
        {
          to: "/projects/$projectId/activity",
          params: { projectId: "33333333-3333-4333-8333-333333333333" },
          search: {}
        }
      ],
      [
        {
          to: "/projects/$projectId/messages",
          params: { projectId: "44444444-4444-4444-8444-444444444444" },
          search: { chat: "55555555-5555-4555-8555-555555555555" }
        }
      ],
      [
        {
          to: "/projects/$projectId/tasks",
          params: { projectId: "11111111-1111-4111-8111-111111111111" },
          search: {
            task: "22222222-2222-4222-8222-222222222222",
            branch: "66666666-6666-4666-8666-666666666666"
          }
        }
      ]
    ]);
    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("unlistens when the provider is disposed before subscription resolves", async () => {
    let resolve!: (unsubscribe: () => void) => void;
    const unlisten = vi.fn();
    const platform = {
      onNotificationAction: vi.fn(
        () => new Promise<() => void>((done) => (resolve = done))
      )
    };
    const stop = watchNotificationActions(platform, { navigate: vi.fn() });
    stop();
    resolve(unlisten);
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
