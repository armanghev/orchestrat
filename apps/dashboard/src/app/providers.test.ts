import { describe, expect, it, vi } from "vitest";
import type { AuthSnapshot } from "@/features/auth/auth-client";
import { createDashboardQueryClient } from "./query-client";
import { watchAuthSessionBoundaries } from "./providers";

function authFixture(initial: AuthSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    auth: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }
    },
    emit(next: AuthSnapshot) { snapshot = next; listeners.forEach((listener) => listener()); }
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
    expect(navigate).not.toHaveBeenCalled();
    stop();
  });

  it("does not clear cache for a same-user token refresh", () => {
    const f = authFixture({ status: "signedIn", identityKey: "same-user" });
    const queryClient = createDashboardQueryClient();
    queryClient.setQueryData(["private"], "retained");
    const stop = watchAuthSessionBoundaries(f.auth, queryClient, { navigate: vi.fn() });
    f.emit({ status: "signedIn", identityKey: "same-user" });
    expect(queryClient.getQueryData(["private"])).toBe("retained");
    stop();
  });

  it("clears cache and navigates root on sign-out even after an intermediate error", () => {
    const f = authFixture({ status: "signedIn", identityKey: "account-a" });
    const queryClient = createDashboardQueryClient();
    queryClient.setQueryData(["private"], "account-a-data");
    const navigate = vi.fn();
    const stop = watchAuthSessionBoundaries(f.auth, queryClient, { navigate });
    f.emit({ status: "error", code: "offline", message: "Try again." });
    f.emit({ status: "signedOut" });
    expect(queryClient.getQueryData(["private"])).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
    stop();
  });
});
