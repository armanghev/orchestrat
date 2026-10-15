import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LocalIntegrationStatus, Platform } from "@/platform/contract";
import { PlatformProvider } from "@/platform/provider";
import {
  buildCliEnvironment,
  LocalIntegrationStatusSection
} from "./local-integration-status";

function platform(overrides: Partial<Platform> = {}): Platform {
  return {
    kind: "web",
    preferences: { load: vi.fn(), save: vi.fn() },
    openExternal: vi.fn(),
    onAuthCallback: vi.fn(async () => () => undefined),
    ...overrides
  };
}

describe("LocalIntegrationStatusSection", () => {
  it("builds safe CLI origins for dev and production", () => {
    expect(
      buildCliEnvironment("web", {
        apiUrl: "http://localhost:8801",
        webUrl: "http://localhost:8813"
      })
    ).toBe(
      "ORCHESTRAT_API_URL='http://localhost:8801' ORCHESTRAT_WEB_URL='http://localhost:8813' "
    );
    expect(
      buildCliEnvironment("desktop", {
        apiUrl: "https://api.orchestrat.dev",
        webUrl: "https://app.orchestrat.dev"
      })
    ).toBe("");
  });

  it("renders unsupported immediately when the platform has no status method", () => {
    render(
      <PlatformProvider value={platform()}>
        <LocalIntegrationStatusSection projectId="p1" />
      </PlatformProvider>
    );
    expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
  });

  it("renders safe readiness results without secret values", async () => {
    const value = platform({
      localIntegrationStatus: vi.fn(async () => ({
        supported: true,
        cli_exists: true,
        project_mapping: true,
        integrations: {
          codex: { mapped: true, mcp: true, hooks: true, credential: true }
        }
      }))
    });
    render(
      <PlatformProvider value={value}>
        <LocalIntegrationStatusSection projectId="p1" />
      </PlatformProvider>
    );
    expect((await screen.findAllByText("Ready")).length).toBe(3);
    expect(document.body.textContent).not.toContain("orch_agent_");
  });

  it("gives browser users safe setup guidance and supports refresh", async () => {
    const writeText = vi.fn(async () => undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    const value = platform();
    render(
      <PlatformProvider value={value}>
        <LocalIntegrationStatusSection projectId="project-123" />
      </PlatformProvider>
    );
    expect(
      screen.getByText(/browser cannot inspect local agent configuration/i)
    ).toBeInTheDocument();
    const setupCode = screen.getByText(/npx @orchestrat\/cli@latest setup/);
    const expectedSetupCommand = setupCode.textContent ?? "";
    expect(setupCode).toBeVisible();
    expect(screen.getByText("project-123")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Copy setup command" })
    );
    expect(writeText).toHaveBeenCalledWith(expectedSetupCommand);
    expect(await screen.findByText("Setup command copied.")).toBeVisible();
    expect(
      screen.getByText(/Setup requires macOS, Node\.js 20\+/i)
    ).toBeInTheDocument();
  });

  it("does not show the prior project's readiness while switching projects", async () => {
    let resolveSecond: (value: LocalIntegrationStatus) => void = () =>
      undefined;
    const localIntegrationStatus = vi.fn((id: string) =>
      id === "p1"
        ? Promise.resolve({
            supported: true,
            cli_exists: true,
            project_mapping: true,
            integrations: {}
          })
        : new Promise<LocalIntegrationStatus>((resolve) => {
            resolveSecond = resolve;
          })
    );
    const value = platform({ kind: "desktop", localIntegrationStatus });
    const view = render(
      <PlatformProvider value={value}>
        <LocalIntegrationStatusSection projectId="p1" />
      </PlatformProvider>
    );
    await screen.findAllByText("Ready");
    view.rerender(
      <PlatformProvider value={value}>
        <LocalIntegrationStatusSection projectId="p2" />
      </PlatformProvider>
    );
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    resolveSecond({
      supported: true,
      cli_exists: false,
      project_mapping: false,
      integrations: {}
    });
  });

  it("refreshes native readiness on demand", async () => {
    const localIntegrationStatus = vi.fn(async () => ({
      supported: true,
      cli_exists: false,
      project_mapping: false,
      integrations: {}
    }));
    render(
      <PlatformProvider
        value={platform({ kind: "desktop", localIntegrationStatus })}
      >
        <LocalIntegrationStatusSection projectId="p1" />
      </PlatformProvider>
    );
    await screen.findByText(
      "No local connection is mapped to this project yet."
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Refresh status" }));
    await vi.waitFor(() =>
      expect(localIntegrationStatus).toHaveBeenCalledTimes(2)
    );
  });

  it("redacts rejected platform errors", async () => {
    const value = platform({
      localIntegrationStatus: vi.fn(async () => {
        throw new Error("transport failed orch_agent_unique-secret");
      })
    });
    render(
      <PlatformProvider value={value}>
        <LocalIntegrationStatusSection projectId="p1" />
      </PlatformProvider>
    );
    expect(
      await screen.findByText("Unable to read local integration status.")
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("orch_agent_unique-secret");
  });
});
