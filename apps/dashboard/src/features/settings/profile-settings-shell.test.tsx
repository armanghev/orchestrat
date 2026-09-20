import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProfileSettingsShell } from "./profile-settings-shell";

const navigate = vi.fn();
vi.mock("@/platform/provider", () => ({
  usePlatform: () => ({ kind: "browser" })
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href="/profile" {...props}>
      {children}
    </a>
  ),
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

describe("ProfileSettingsShell", () => {
  it("provides a fixed settings sidebar and returns to the dashboard", async () => {
    render(
      <ProfileSettingsShell>
        <h1>Profile</h1>
      </ProfileSettingsShell>
    );

    expect(
      screen.getByRole("complementary", { name: "Settings" })
    ).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: "Settings navigation" })
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Profile" })).toHaveAttribute(
      "aria-current",
      "page"
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Back to dashboard" })
    );
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/overview",
      params: { projectId: "project-1" }
    });
  });
});
