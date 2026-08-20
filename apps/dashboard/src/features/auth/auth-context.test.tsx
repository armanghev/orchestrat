import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthContext, useAuthSnapshot } from "./auth-context";
import { loadingAuthClient } from "./auth-client";

function LoadingConsumer() {
  const snapshot = useAuthSnapshot();
  return <output>{snapshot.status}</output>;
}

describe("loading auth client", () => {
  it("provides a cached loading snapshot to useSyncExternalStore", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(
      <AuthContext.Provider value={loadingAuthClient}>
        <LoadingConsumer />
      </AuthContext.Provider>
    );

    expect(screen.getByText("loading")).toBeVisible();
    expect(loadingAuthClient.getSnapshot()).toBe(
      loadingAuthClient.getSnapshot()
    );
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain(
      "The result of getSnapshot should be cached"
    );
    consoleError.mockRestore();
  });
});
