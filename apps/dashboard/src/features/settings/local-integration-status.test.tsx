import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Platform } from "@/platform/contract";
import { PlatformProvider } from "@/platform/provider";
import { LocalIntegrationStatusSection } from "./local-integration-status";

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
