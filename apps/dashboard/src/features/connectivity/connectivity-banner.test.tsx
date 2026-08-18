import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hierarchyKeys } from "@/features/hierarchy/query-options";
import { ConnectivityBanner } from "./connectivity-banner";

const originalOnline = navigator.onLine;

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: online
  });
}

function renderBanner() {
  const queryClient = new QueryClient();
  const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ConnectivityBanner />
    </QueryClientProvider>
  );
  return { ...view, invalidateQueries, queryClient };
}

afterEach(() => {
  setOnline(originalOnline);
  vi.restoreAllMocks();
});

describe("ConnectivityBanner", () => {
  it("renders cached-data status when initially offline", () => {
    setOnline(false);
    renderBanner();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Offline — showing cached project data."
    );
  });

  it("removes the banner and invalidates hierarchy once when the browser comes online", () => {
    setOnline(false);
    const { invalidateQueries } = renderBanner();
    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hierarchyKeys.all
    });
  });

  it("adds the banner while offline without clearing cached query data", () => {
    setOnline(true);
    const { queryClient } = renderBanner();
    const clear = vi.spyOn(queryClient, "clear");
    setOnline(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Offline — showing cached project data."
    );
    expect(clear).not.toHaveBeenCalled();
  });

  it("removes online and offline event listeners when unmounted", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderBanner();
    unmount();
    const eventTypes = add.mock.calls.map(([event]) => event);
    expect(eventTypes).toContain("online");
    expect(eventTypes).toContain("offline");
    expect(remove.mock.calls.some(([event]) => event === "online")).toBe(true);
    expect(remove.mock.calls.some(([event]) => event === "offline")).toBe(true);
  });
});
