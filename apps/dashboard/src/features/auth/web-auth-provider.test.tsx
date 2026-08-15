import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { loadingAuthClient, type AuthClient, type AuthSnapshot } from "./auth-client";
import { useAuthClient, useAuthSnapshot } from "./auth-context";
import { WebAuthProvider } from "./web-auth-provider";

class FakeWebClient implements AuthClient {
  readonly capabilities = { github: true, magicLink: true };
  private snapshot: AuthSnapshot = { status: "loading" };
  private readonly listeners = new Set<() => void>();
  initialize = vi.fn(async () => { this.snapshot = { status: "signedOut" }; this.listeners.forEach((listener) => listener()); });
  dispose = vi.fn();
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  signInWithGitHub = vi.fn(async () => undefined);
  sendMagicLink = vi.fn(async () => undefined);
  completeSignIn = vi.fn(async () => undefined);
  signOut = vi.fn(async () => undefined);
  expireSession = vi.fn(async () => undefined);
  getAccessToken = vi.fn(async () => null);
}

function Status() { return <p>{useAuthSnapshot().status}</p>; }
function ClientIdentity() { return <p>{useAuthClient() === loadingAuthClient ? "placeholder" : "real"}</p>; }

describe("WebAuthProvider", () => {

  it("does not expose the real client before delayed initialization settles in StrictMode", async () => {
    let finish!: () => void;
    const client = new FakeWebClient();
    client.initialize.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finish = () => { resolve(); };
    }));
    render(<StrictMode><WebAuthProvider client={client}><ClientIdentity /></WebAuthProvider></StrictMode>);
    expect(screen.getByText("placeholder")).toBeVisible();
    finish();
    await screen.findByText("real");
    expect(client.initialize).toHaveBeenCalledOnce();
  });

  it("keeps one injected web client through StrictMode replay and disposes on unmount", async () => {
    const client = new FakeWebClient();
    const view = render(<StrictMode><WebAuthProvider client={client}><Status /></WebAuthProvider></StrictMode>);
    await screen.findByText("signedOut");
    expect(client.initialize).toHaveBeenCalledOnce();
    expect(client.dispose).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(client.dispose).toHaveBeenCalledOnce());
  });
});
