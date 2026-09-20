import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@/lib/api/client";
import { ProfileSettingsPage } from "./profile-settings-page";

vi.mock("@/features/theme/theme-provider", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() })
}));

describe("ProfileSettingsPage", () => {
  it("edits the avatar from the pencil menu", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ProfileSettingsPage
        profile={{
          user_id: "user-1",
          provider: "test",
          email: "arman@example.com",
          username: "arman",
          full_name: "Arman",
          avatar_url: "https://example.com/avatar.png"
        }}
        api={{} as ApiClient}
        onSignOut={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Edit profile picture" })
    );
    expect(
      screen.getByRole("menuitem", { name: "Change picture" })
    ).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "Remove picture" }));
    expect(container.querySelector("img")).not.toBeInTheDocument();

    const username = screen.getByLabelText("Username");
    expect(username).toHaveValue("arman");
    expect(screen.getByText("@", { exact: true })).toBeVisible();
  });
});
