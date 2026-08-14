import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Platform, PreferenceStore } from "./contract";
import { PreferencesProvider, usePreferences } from "./preferences-provider";
import type { Preferences } from "./preferences";
import { PlatformProvider } from "./provider";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const defaults = {
  theme: "system" as const,
  railMode: "projects" as const,
  pinnedProjectIds: [],
  recentProjectIds: [],
  contextSidebarCollapsed: false
};

function platform(preferences: PreferenceStore): Platform {
  return {
    kind: "web",
    preferences,
    openExternal: vi.fn(async () => undefined),
    onAuthCallback: vi.fn(async () => () => undefined)
  };
}

function Probe() {
  const { preferences, ready, update } = usePreferences();
  return (
    <>
      <output>{`${ready}:${preferences.theme}:${preferences.railMode}:${preferences.contextSidebarCollapsed}`}</output>
      <button onClick={() => void update({ theme: "dark" })}>dark</button>
      <button onClick={() => void update({ theme: "light" })}>light</button>
      <button
        onClick={() =>
          void update({
            contextSidebarCollapsed: !preferences.contextSidebarCollapsed
          })
        }
      >
        toggle sidebar
      </button>
    </>
  );
}

function renderPreferences(
  store: PreferenceStore,
  initialPreferences?: Preferences
) {
  return render(
    <PlatformProvider value={platform(store)}>
      <PreferencesProvider
        store={store}
        initialPreferences={initialPreferences}
      >
        <Probe />
      </PreferencesProvider>
    </PlatformProvider>
  );
}

describe("PreferencesProvider", () => {
  it("loads the selected preference store once when provider props rerender", async () => {
    const first: PreferenceStore = { load: vi.fn(async () => defaults), save: vi.fn(async () => undefined) };
    const second: PreferenceStore = { load: vi.fn(async () => defaults), save: vi.fn(async () => undefined) };
    const view = render(
      <PlatformProvider value={platform(first)}><PreferencesProvider store={first}><Probe /></PreferencesProvider></PlatformProvider>
    );
    await waitFor(() => expect(first.load).toHaveBeenCalledTimes(1));

    view.rerender(
      <PlatformProvider value={platform(second)}><PreferencesProvider store={second}><Probe /></PreferencesProvider></PlatformProvider>
    );

    expect(first.load).toHaveBeenCalledTimes(1);
    expect(second.load).not.toHaveBeenCalled();
  });

  it("merges an update made before load resolves instead of letting load overwrite it", async () => {
    const load = deferred<unknown>();
    const save = vi.fn(async () => undefined);
    const user = userEvent.setup();
    renderPreferences({ load: () => load.promise, save });

    await user.click(screen.getByRole("button", { name: "dark" }));
    expect(screen.getByText("false:dark:projects:false")).toBeInTheDocument();

    await act(async () =>
      load.resolve({ ...defaults, railMode: "organizations" })
    );
    await waitFor(() =>
      expect(
        screen.getByText("true:dark:organizations:false")
      ).toBeInTheDocument()
    );
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        ...defaults,
        theme: "dark",
        railMode: "organizations"
      })
    );
  });

  it("restores the committed snapshot after consecutive save failures", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const third = deferred<void>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);
    const user = userEvent.setup();
    renderPreferences(
      { load: vi.fn(async () => null), save },
      { ...defaults, theme: "light" }
    );

    await user.click(screen.getByRole("button", { name: "dark" }));
    await act(async () => first.resolve());
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "toggle sidebar" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await act(async () => second.reject(new Error("offline")));
    await waitFor(() =>
      expect(screen.getByText("true:dark:projects:false")).toBeInTheDocument()
    );

    await user.click(screen.getByRole("button", { name: "light" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    await act(async () => third.reject(new Error("offline again")));
    await waitFor(() =>
      expect(screen.getByText("true:dark:projects:false")).toBeInTheDocument()
    );
  });

  it("clears a stale save failure when a later revision succeeds", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const save = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const user = userEvent.setup();
    renderPreferences({ load: vi.fn(async () => null), save }, defaults);

    await user.click(screen.getByRole("button", { name: "dark" }));
    await user.click(screen.getByRole("button", { name: "toggle sidebar" }));
    await act(async () => first.reject(new Error("stale")));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve());

    await waitFor(() =>
      expect(screen.getByText("true:dark:projects:true")).toBeInTheDocument()
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
