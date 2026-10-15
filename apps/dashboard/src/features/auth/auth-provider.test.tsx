import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAuthClient } from "@/test/fake-auth-client";
import { useAuthSnapshot } from "./auth-context";
import { AuthProvider } from "./auth-provider";

const createBrowserWebAuthClient = vi.hoisted(() => vi.fn());
vi.mock("./web-auth-client", () => ({ createBrowserWebAuthClient }));

const config = (
  runtime: "desktop" | "web",
  { e2eAuth = false, host = `${runtime}-api` } = {}
) => ({
  apiUrl: `https://${host}.example.com`,
  e2eAuth,
  runtime
});

function AuthStatus() {
  return <p>{useAuthSnapshot().status}</p>;
}

describe("AuthProvider", () => {
  beforeEach(() => createBrowserWebAuthClient.mockReset());

  it.each(["web", "desktop"] as const)(
    "signs in with the password client on %s",
    async (runtime) => {
      const client = new FakeAuthClient({ status: "signedOut" });
      createBrowserWebAuthClient.mockReturnValueOnce(client);
      render(
        <StrictMode>
          <AuthProvider config={config(runtime)}>
            <AuthStatus />
          </AuthProvider>
        </StrictMode>
      );
      await screen.findByText("signedOut");
      expect(createBrowserWebAuthClient).toHaveBeenCalledOnce();
      expect(createBrowserWebAuthClient).toHaveBeenCalledWith(
        `https://${runtime}-api.example.com`
      );
      expect(client.initialize).toHaveBeenCalledOnce();
    }
  );

  it("disposes the client when unmounted", async () => {
    const client = Object.assign(new FakeAuthClient({ status: "signedOut" }), {
      dispose: vi.fn()
    });
    createBrowserWebAuthClient.mockReturnValueOnce(client);
    const view = render(
      <AuthProvider config={config("desktop", { host: "unmount-api" })}>
        <AuthStatus />
      </AuthProvider>
    );
    await screen.findByText("signedOut");
    view.unmount();
    await waitFor(() => expect(client.dispose).toHaveBeenCalledOnce());
  });

  it("refuses stubbed e2e auth outside the e2e build", () => {
    render(
      <AuthProvider config={config("web", { e2eAuth: true })}>
        <AuthStatus />
      </AuthProvider>
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "E2E authentication is only available in e2e mode."
    );
    expect(createBrowserWebAuthClient).not.toHaveBeenCalled();
  });
});
