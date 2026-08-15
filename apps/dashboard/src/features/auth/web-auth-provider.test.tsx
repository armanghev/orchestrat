import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadingAuthClient, type AuthClient, type AuthSnapshot } from "./auth-client";
import { useAuthClient, useAuthSnapshot } from "./auth-context";
import { WebAuthProvider } from "./web-auth-provider";

const createBrowserWebAuthClient = vi.hoisted(() => vi.fn());
vi.mock("./web-auth-client", () => ({ createBrowserWebAuthClient }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeWebClient implements AuthClient {
  readonly capabilities = { github: true, magicLink: true };
  private snapshot: AuthSnapshot = { status: "loading" };
  private readonly listeners = new Set<() => void>();
  constructor(readonly label: string) {}
  initialize = vi.fn(async () => { this.setSnapshot({ status: "signedOut" }); });
  dispose = vi.fn();
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  signInWithGitHub = vi.fn(async () => undefined);
  sendMagicLink = vi.fn(async () => undefined);
  completeSignIn = vi.fn(async () => undefined);
  signOut = vi.fn(async () => undefined);
  expireSession = vi.fn(async () => undefined);
  getAccessToken = vi.fn(async () => null);
  initializeAfter(promise: Promise<void>) {
    this.initialize.mockImplementationOnce(async () => { await promise; this.setSnapshot({ status: "signedOut" }); });
  }
  private setSnapshot(snapshot: AuthSnapshot) {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}

const productionConfig = (name: string) => ({
  supabaseUrl: `https://${name}.supabase.co`,
  supabasePublishableKey: `sb_publishable_${name}`,
  callbackUrl: `https://${name}.example.com/auth/callback`
});

function Status() { return <p>{useAuthSnapshot().status}</p>; }
function ClientLabel() {
  const client = useAuthClient();
  return <p>{client === loadingAuthClient ? "placeholder" : (client as FakeWebClient).label}</p>;
}

describe("WebAuthProvider", () => {
  beforeEach(() => { createBrowserWebAuthClient.mockReset(); });

  it("does not expose the real client before delayed initialization settles in StrictMode", async () => {
    const pending = deferred();
    const client = new FakeWebClient("injected");
    client.initializeAfter(pending.promise);
    render(<StrictMode><WebAuthProvider client={client}><ClientLabel /></WebAuthProvider></StrictMode>);
    expect(screen.getByText("placeholder")).toBeVisible();
    pending.resolve();
    await screen.findByText("injected");
    expect(client.initialize).toHaveBeenCalledOnce();
  });

  it("keeps one injected web client through StrictMode replay and disposes on unmount", async () => {
    const client = new FakeWebClient("injected-strict");
    const view = render(<StrictMode><WebAuthProvider client={client}><Status /></WebAuthProvider></StrictMode>);
    await screen.findByText("signedOut");
    expect(client.initialize).toHaveBeenCalledOnce();
    expect(client.dispose).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(client.dispose).toHaveBeenCalledOnce());
  });



  it("keeps a production lease live through StrictMode effect replay", async () => {
    const client = new FakeWebClient("production-strict");
    createBrowserWebAuthClient.mockReturnValueOnce(client);
    const view = render(
      <StrictMode><WebAuthProvider {...productionConfig("strict-production")}><ClientLabel /></WebAuthProvider></StrictMode>
    );
    await screen.findByText("production-strict");
    expect(createBrowserWebAuthClient).toHaveBeenCalledOnce();
    expect(client.initialize).toHaveBeenCalledOnce();
    expect(client.dispose).not.toHaveBeenCalled();
    view.unmount();
    await waitFor(() => expect(client.dispose).toHaveBeenCalledOnce());
  });

  it("shares one production client per active signature and disposes only after the final lease", async () => {
    const client = new FakeWebClient("shared-production");
    createBrowserWebAuthClient.mockReturnValueOnce(client);
    const config = productionConfig("shared-lease");
    const first = render(<WebAuthProvider {...config}><ClientLabel /></WebAuthProvider>);
    const second = render(<WebAuthProvider {...config}><ClientLabel /></WebAuthProvider>);
    await screen.findAllByText("shared-production");
    expect(createBrowserWebAuthClient).toHaveBeenCalledOnce();
    expect(client.initialize).toHaveBeenCalledOnce();
    first.unmount();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.dispose).not.toHaveBeenCalled();
    second.unmount();
    await waitFor(() => expect(client.dispose).toHaveBeenCalledOnce());
  });

  it("removes a finally disposed production lease so a genuine remount creates a live client", async () => {
    const first = new FakeWebClient("production-first");
    const second = new FakeWebClient("production-second");
    createBrowserWebAuthClient.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const config = productionConfig("remount-lifecycle");

    const initial = render(<WebAuthProvider {...config}><ClientLabel /></WebAuthProvider>);
    await screen.findByText("production-first");
    initial.unmount();
    await waitFor(() => expect(first.dispose).toHaveBeenCalledOnce());

    render(<WebAuthProvider {...config}><ClientLabel /></WebAuthProvider>);
    await screen.findByText("production-second");
    expect(createBrowserWebAuthClient).toHaveBeenCalledTimes(2);
    expect(second.initialize).toHaveBeenCalledOnce();
  });


  it("hides an initialized production A while a changed-signature B initializes", async () => {
    const oldClient = new FakeWebClient("ready-production-a");
    const pending = deferred();
    const newClient = new FakeWebClient("delayed-production-b");
    newClient.initializeAfter(pending.promise);
    createBrowserWebAuthClient.mockReturnValueOnce(oldClient).mockReturnValueOnce(newClient);
    const view = render(<WebAuthProvider {...productionConfig("ready-a")}><ClientLabel /></WebAuthProvider>);
    await screen.findByText("ready-production-a");

    view.rerender(<WebAuthProvider {...productionConfig("delayed-b")}><ClientLabel /></WebAuthProvider>);
    expect(screen.getByText("placeholder")).toBeVisible();
    expect(newClient.initialize).toHaveBeenCalledOnce();
    await waitFor(() => expect(oldClient.dispose).toHaveBeenCalledOnce());
    pending.resolve();
    await screen.findByText("delayed-production-b");
    expect(newClient.dispose).not.toHaveBeenCalled();
  });

  it("shows loading for a new production signature, disposes A, and ignores delayed A initialization", async () => {
    const oldPending = deferred();
    const newPending = deferred();
    const oldClient = new FakeWebClient("production-a");
    const newClient = new FakeWebClient("production-b");
    oldClient.initializeAfter(oldPending.promise);
    newClient.initializeAfter(newPending.promise);
    createBrowserWebAuthClient.mockReturnValueOnce(oldClient).mockReturnValueOnce(newClient);

    const view = render(<WebAuthProvider {...productionConfig("signature-a")}><ClientLabel /></WebAuthProvider>);
    expect(screen.getByText("placeholder")).toBeVisible();
    view.rerender(<WebAuthProvider {...productionConfig("signature-b")}><ClientLabel /></WebAuthProvider>);
    expect(screen.getByText("placeholder")).toBeVisible();
    newPending.resolve();
    await screen.findByText("production-b");
    oldPending.resolve();
    await waitFor(() => expect(oldClient.dispose).toHaveBeenCalledOnce());
    expect(screen.getByText("production-b")).toBeVisible();
    expect(newClient.dispose).not.toHaveBeenCalled();
    expect(createBrowserWebAuthClient).toHaveBeenCalledTimes(2);
  });

  it("treats an injected-client change as a new loading lease and disposes the old client", async () => {
    const first = new FakeWebClient("injected-a");
    const pending = deferred();
    const second = new FakeWebClient("injected-b");
    second.initializeAfter(pending.promise);
    const view = render(<WebAuthProvider client={first}><ClientLabel /></WebAuthProvider>);
    await screen.findByText("injected-a");

    view.rerender(<WebAuthProvider client={second}><ClientLabel /></WebAuthProvider>);
    expect(screen.getByText("placeholder")).toBeVisible();
    pending.resolve();
    await screen.findByText("injected-b");
    await waitFor(() => expect(first.dispose).toHaveBeenCalledOnce());
    expect(second.initialize).toHaveBeenCalledOnce();
    expect(second.dispose).not.toHaveBeenCalled();
  });
});
