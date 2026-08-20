import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "@/platform/contract";
import { PlatformProvider } from "@/platform/provider";
import { PreferencesProvider } from "@/platform/preferences-provider";
import { ThemeProvider, useTheme } from "./theme-provider";

function platform(): Platform {
  return {
    kind: "web",
    preferences: { load: vi.fn(), save: vi.fn() },
    openExternal: vi.fn(),
    onAuthCallback: vi.fn(async () => () => undefined)
  };
}
function Probe() {
  const theme = useTheme();
  return (
    <>
      <span>
        {theme.theme}/{theme.resolvedTheme}
      </span>
      <button onClick={() => theme.setTheme("dark")}>dark</button>
    </>
  );
}
function renderTheme(initial: "system" | "light" | "dark" = "system") {
  const value = platform();
  return {
    value,
    ...render(
      <PlatformProvider value={value}>
        <PreferencesProvider
          initialPreferences={{
            theme: initial,
            railMode: "projects",
            pinnedProjectIds: [],
            recentProjectIds: [],
            contextSidebarCollapsed: false
          }}
        >
          <ThemeProvider>
            <Probe />
          </ThemeProvider>
        </PreferencesProvider>
      </PlatformProvider>
    )
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
describe("ThemeProvider", () => {
  it("keeps system in preferences while mirroring each resolved system transition once", () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined;
    const media = {
      matches: false,
      addEventListener: vi.fn(
        (_type: string, value: (event: MediaQueryListEvent) => void) => {
          listener = value;
        }
      ),
      removeEventListener: vi.fn()
    } as unknown as MediaQueryList;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => media)
    );
    const view = renderTheme();
    expect(screen.getByText("system/light")).toBeInTheDocument();
    expect(localStorage.getItem("orchestrat.theme")).toBe("system");
    expect(media.addEventListener).toHaveBeenCalledTimes(1);
    act(() => listener?.({ matches: true } as MediaQueryListEvent));
    expect(screen.getByText("system/dark")).toBeInTheDocument();
    expect(localStorage.getItem("orchestrat.theme")).toBe("system");
    expect(media.addEventListener).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(media.removeEventListener).toHaveBeenCalledTimes(1);
  });
  it("does not persist a selection that is already active", async () => {
    const { value } = renderTheme("dark");
    await act(async () => {
      screen.getByRole("button", { name: "dark" }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(value.preferences.save).not.toHaveBeenCalled();
  });
  it("writes an explicit resolved selection and removes the system listener", () => {
    const media = {
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    } as unknown as MediaQueryList;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => media)
    );
    renderTheme();
    act(() => screen.getByRole("button", { name: "dark" }).click());
    expect(localStorage.getItem("orchestrat.theme")).toBe("dark");
    expect(media.removeEventListener).toHaveBeenCalledTimes(1);
  });
});
