import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OrganizationSettingsShell } from "./organization-settings-shell";

const navigate = vi.fn();
vi.mock("@/platform/provider", () => ({
  usePlatform: () => ({ kind: "browser" })
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate
}));

vi.mock("@/platform/preferences-provider", () => ({
  usePreferences: () => ({
    preferences: {
      recentProjectIds: ["project-1"],
      pinnedProjectIds: []
    }
  })
}));

describe("OrganizationSettingsShell", () => {
  it("provides a top-toolbar dashboard link without a sidebar", async () => {
    const user = userEvent.setup();
    render(
      <OrganizationSettingsShell>
        <h1>Organization settings</h1>
      </OrganizationSettingsShell>
    );

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to dashboard" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/overview",
      params: { projectId: "project-1" }
    });
  });
});
