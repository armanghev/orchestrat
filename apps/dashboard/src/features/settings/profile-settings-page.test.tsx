import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AuthRequestError } from "@/features/auth/auth-client";
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
        onSignOutEverywhere={vi.fn(async () => undefined)}
        onChangePassword={vi.fn(async () => undefined)}
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
  function renderPage(
    overrides: Partial<Parameters<typeof ProfileSettingsPage>[0]> = {}
  ) {
    const props = {
      profile: {
        user_id: "user-1",
        provider: "local",
        email: "arman@example.com",
        username: "arman",
        full_name: "Arman",
        avatar_url: null,
        is_instance_admin: true
      },
      api: {} as ApiClient,
      onSignOut: vi.fn(),
      onSignOutEverywhere: vi.fn(async () => undefined),
      onChangePassword: vi.fn<(current: string, next: string) => Promise<void>>(
        async () => undefined
      ),
      ...overrides
    };
    render(<ProfileSettingsPage {...props} />);
    return props;
  }

  async function fillPassword(current: string, next: string, confirm = next) {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Current password"), current);
    await user.type(screen.getByLabelText("New password"), next);
    await user.type(screen.getByLabelText("Confirm new password"), confirm);
    await user.click(screen.getByRole("button", { name: "Change password" }));
    return user;
  }

  it("shows the server admin role", () => {
    renderPage();
    expect(screen.getByText("Admin of this Orchestrat server")).toBeVisible();
  });

  it("changes the password and says other sessions were signed out", async () => {
    const props = renderPage();
    await fillPassword("old-password", "new password 123");
    expect(props.onChangePassword).toHaveBeenCalledWith(
      "old-password",
      "new password 123"
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Password changed. Your other sessions were signed out."
    );
    expect(screen.getByLabelText("Current password")).toHaveValue("");
  });

  it("checks the new password before sending it", async () => {
    const props = renderPage();
    await fillPassword("old-password", "short", "different");
    expect(screen.getByLabelText("New password")).toHaveAccessibleDescription(
      /Use at least 10 characters\./
    );
    expect(
      screen.getByLabelText("Confirm new password")
    ).toHaveAccessibleDescription("The passwords don't match.");
    expect(props.onChangePassword).not.toHaveBeenCalled();
  });

  it("shows a wrong current password and the rate limit inline", async () => {
    const onChangePassword = vi
      .fn()
      .mockRejectedValueOnce(
        new AuthRequestError("x", "PASSWORD_INCORRECT", 403)
      )
      .mockRejectedValueOnce(
        new AuthRequestError("x", "RATE_LIMITED", 429, 900)
      );
    renderPage({ onChangePassword });
    const user = await fillPassword("wrong-password", "new password 123");
    await waitFor(() =>
      expect(
        screen.getByLabelText("Current password")
      ).toHaveAccessibleDescription("Your current password is incorrect.")
    );

    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Try again in 900 seconds."
    );
  });

  it("signs out everywhere and reports a failure", async () => {
    const onSignOutEverywhere = vi
      .fn()
      .mockRejectedValueOnce(new AuthRequestError("x", "NETWORK_ERROR", null))
      .mockResolvedValueOnce(undefined);
    renderPage({ onSignOutEverywhere });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Sign out everywhere" })
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn't reach the server."
    );
    await user.click(
      screen.getByRole("button", { name: "Sign out everywhere" })
    );
    expect(onSignOutEverywhere).toHaveBeenCalledTimes(2);
  });
});
