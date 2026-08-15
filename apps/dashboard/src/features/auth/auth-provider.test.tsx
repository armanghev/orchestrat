import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSnapshot } from "./auth-context";
import { AuthProvider } from "./auth-provider";

const mockedBridge = vi.hoisted(() => ({
  beginGitHub: vi.fn(async () => undefined),
  sendMagicLink: vi.fn(async () => undefined),
  complete: vi.fn(async () => ({
    accessToken: "access-1",
    expiresAtMs: 60_000
  })),
  refresh: vi.fn(async () => ({
    accessToken: "access-2",
    expiresAtMs: 60_000
  })),
  restore: vi.fn(async () => null),
  expire: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined)
}));

vi.mock("./desktop-bridge", () => ({ desktopAuthBridge: mockedBridge }));

const desktopConfig = {
  apiUrl: "https://api.test",
  supabaseUrl: null,
  supabasePublishableKey: null,
  webAuthCallbackUrl: null,
  e2eAuth: false,
  runtime: "desktop" as const
};

function AuthStatus() {
  const snapshot = useAuthSnapshot();
  return <p>{snapshot.status}</p>;
}

describe("AuthProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the desktop client usable through StrictMode effect replay", async () => {
    let callback: ((url: URL) => void) | undefined;
    const platform = {
      kind: "desktop" as const,
      preferences: { load: vi.fn(), save: vi.fn() },
      openExternal: vi.fn(async () => undefined),
      onAuthCallback: vi.fn(async (handler: (url: URL) => void) => {
        callback = handler;
        return vi.fn();
      })
    };
    render(
      <StrictMode>
        <AuthProvider config={desktopConfig} platform={platform}>
          <AuthStatus />
        </AuthProvider>
      </StrictMode>
    );

    await screen.findByText("signedOut");
    expect(platform.onAuthCallback).toHaveBeenCalledOnce();
    callback?.(new URL("dev.orchestrat.app://auth/callback?code=a&sb_flow_id=b"));

    await waitFor(() => expect(mockedBridge.complete).toHaveBeenCalledOnce());
    expect(screen.getByText("signedIn")).toBeInTheDocument();
  });

  it("disposes the desktop client when unmounted", async () => {
    let callback: ((url: URL) => void) | undefined;
    const unlisten = vi.fn();
    const platform = {
      kind: "desktop" as const,
      preferences: { load: vi.fn(), save: vi.fn() },
      openExternal: vi.fn(async () => undefined),
      onAuthCallback: vi.fn(async (handler: (url: URL) => void) => {
        callback = handler;
        return unlisten;
      })
    };
    const view = render(
      <AuthProvider config={desktopConfig} platform={platform}>
        <p>dashboard</p>
      </AuthProvider>
    );
    await waitFor(() => expect(platform.onAuthCallback).toHaveBeenCalledOnce());

    view.unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
    callback?.(new URL("dev.orchestrat.app://auth/callback?code=a&sb_flow_id=b"));
    await Promise.resolve();

    expect(mockedBridge.complete).not.toHaveBeenCalled();
  });
});
