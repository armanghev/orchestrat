import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "./auth-context";
import type {
  AuthClient,
  AuthCompletionResult,
  AuthSnapshot
} from "./auth-client";
import { AuthCallbackScreen } from "./auth-callback-screen";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function client(
  snapshot: AuthSnapshot,
  completeSignIn: (
    callbackUrl: string
  ) => Promise<AuthCompletionResult> = vi.fn(async () => ({
    status: "error" as const
  }))
): AuthClient {
  return {
    capabilities: { github: true, magicLink: true },
    initialize: vi.fn(async () => undefined),
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    signInWithGitHub: vi.fn(async () => undefined),
    sendMagicLink: vi.fn(async () => undefined),
    completeSignIn,
    signOut: vi.fn(async () => undefined),
    expireSession: vi.fn(async () => undefined),
    getAccessToken: vi.fn(async () => null)
  };
}

describe("AuthCallbackScreen", () => {
  let browserPathBeforeTest = "";

  beforeEach(() => {
    browserPathBeforeTest = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  });

  afterEach(() => {
    window.history.replaceState({}, "", browserPathBeforeTest);
  });

  it("announces callback progress without rendering callback parameters", async () => {
    window.history.replaceState(
      {},
      "",
      "/auth/callback?code=secret-token&state=opaque"
    );
    const auth = client({ status: "signingIn" });
    const { container } = render(
      <AuthContext.Provider value={auth}>
        <AuthCallbackScreen />
      </AuthContext.Provider>
    );
    expect(screen.getByRole("status")).toHaveTextContent("Completing sign-in");
    await waitFor(() => expect(auth.completeSignIn).toHaveBeenCalledOnce());
    expect(container).not.toHaveTextContent("secret-token");
    expect(container).not.toHaveTextContent("state=opaque");
    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`
    ).toBe("/auth/callback");
  });

  it("reports one attributable success through StrictMode effect replay", async () => {
    const onSuccess = vi.fn();
    const completion = vi.fn(async () => ({
      status: "success" as const,
      identityKey: "account-b"
    }));
    render(
      <StrictMode>
        <AuthContext.Provider
          value={client({ status: "signingIn" }, completion)}
        >
          <AuthCallbackScreen
            callbackUrl={`${window.location.origin}/auth/callback?code=account-b`}
            onSuccess={onSuccess}
          />
        </AuthContext.Provider>
      </StrictMode>
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("account-b"));
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(completion).toHaveBeenCalledOnce();
  });

  it("drops the callback URL after handoff while its promise survives a scrub rerender", async () => {
    const pending = deferred<AuthCompletionResult>();
    const completion = vi.fn(() => pending.promise);
    const onSuccess = vi.fn();
    const auth = client({ status: "signingIn" }, completion);
    const view = render(
      <StrictMode>
        <AuthContext.Provider value={auth}>
          <AuthCallbackScreen
            callbackUrl={`${window.location.origin}/auth/callback?code=one-time-secret`}
            onSuccess={onSuccess}
          />
        </AuthContext.Provider>
      </StrictMode>
    );
    await waitFor(() => expect(completion).toHaveBeenCalledOnce());

    view.rerender(
      <StrictMode>
        <AuthContext.Provider value={auth}>
          <AuthCallbackScreen
            callbackUrl={`${window.location.origin}/auth/callback`}
            onSuccess={onSuccess}
          />
        </AuthContext.Provider>
      </StrictMode>
    );
    expect(completion).toHaveBeenCalledOnce();
    expect(view.container).not.toHaveTextContent("one-time-secret");
    pending.resolve({ status: "success", identityKey: "account-b" });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("account-b"));
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("delivers callback failure after scrub rerender without handing the code off twice", async () => {
    const pending = deferred<AuthCompletionResult>();
    const completion = vi.fn(() => pending.promise);
    const auth = client({ status: "signingIn" }, completion);
    const view = render(
      <StrictMode>
        <AuthContext.Provider value={auth}>
          <AuthCallbackScreen
            callbackUrl={`${window.location.origin}/auth/callback?code=failing-secret`}
          />
        </AuthContext.Provider>
      </StrictMode>
    );
    await waitFor(() => expect(completion).toHaveBeenCalledOnce());
    view.rerender(
      <StrictMode>
        <AuthContext.Provider value={auth}>
          <AuthCallbackScreen
            callbackUrl={`${window.location.origin}/auth/callback`}
          />
        </AuthContext.Provider>
      </StrictMode>
    );
    pending.resolve({ status: "error" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't complete your sign-in."
    );
    expect(completion).toHaveBeenCalledOnce();
    expect(view.container).not.toHaveTextContent("failing-secret");
  });

  it("shows a retry link with a stable message for an auth error", async () => {
    const auth = client({
      status: "error",
      code: "state_mismatch",
      message: "The callback state does not match."
    });
    render(
      <AuthContext.Provider value={auth}>
        <AuthCallbackScreen />
      </AuthContext.Provider>
    );
    await waitFor(() => expect(auth.completeSignIn).toHaveBeenCalledOnce());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "We couldn't complete your sign-in."
    );
    expect(
      screen.queryByText("The callback state does not match.")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/"
    );
  });

  it("shows recovery when callback result is invalid even if an older session is signed in", async () => {
    const completion = vi.fn(async () => ({ status: "error" as const }));
    render(
      <AuthContext.Provider
        value={client(
          { status: "signedIn", identityKey: "account-a" },
          completion
        )}
      >
        <AuthCallbackScreen
          callbackUrl={`${window.location.origin}/auth/callback?error=access_denied`}
        />
      </AuthContext.Provider>
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't complete your sign-in."
    );
  });

  it("shows stable recovery after callback completion rejects", async () => {
    window.history.replaceState(
      {},
      "",
      "/auth/callback?code=secret-token&state=opaque"
    );
    const completion = vi.fn(async () => {
      throw new Error("secret-token");
    });
    const auth = client({ status: "signingIn" }, completion);
    const { container } = render(
      <AuthContext.Provider value={auth}>
        <AuthCallbackScreen />
      </AuthContext.Provider>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't complete your sign-in."
    );
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/"
    );
    expect(container).not.toHaveTextContent("secret-token");
    expect(container).not.toHaveTextContent("opaque");
    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`
    ).toBe("/auth/callback");
  });
});
