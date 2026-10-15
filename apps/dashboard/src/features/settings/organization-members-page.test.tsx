import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { Organization, OrganizationMember } from "@orchestrat/protocol";
import type { ApiClient } from "@/lib/api/client";
import { OrganizationMembersPage } from "./organization-members-page";
import { OrganizationSettingsPage } from "./organization-settings-page";

const studio = (role: Organization["role"]): Organization => ({
  id: "organization-1",
  name: "Studio",
  slug: "studio",
  role,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z"
});

const member = (
  user_id: string,
  role: OrganizationMember["role"]
): OrganizationMember => ({
  user_id,
  username: user_id,
  full_name: user_id[0].toUpperCase() + user_id.slice(1),
  email: `${user_id}@example.com`,
  avatar_url: null,
  role,
  created_at: "2026-01-01T00:00:00.000Z"
});

const olive = member("olive", "owner");
const alice = member("alice", "admin");
const bob = member("bob", "member");

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function membersApi(members: OrganizationMember[]) {
  let current = [...members];
  return {
    listOrganizationMembers: vi.fn(async () => ({ members: current })),
    updateOrganizationMember: vi.fn(
      async (_id: string, userId: string, role: OrganizationMember["role"]) => {
        current = current.map((item) =>
          item.user_id === userId ? { ...item, role } : item
        );
        return current.find((item) => item.user_id === userId)!;
      }
    ),
    removeOrganizationMember: vi.fn(async (_id: string, userId: string) => {
      current = current.filter((item) => item.user_id !== userId);
    }),
    leaveOrganization: vi.fn(async () => undefined)
  };
}

describe("OrganizationMembersPage", () => {
  it("lets an admin manage members and admins but not owners", async () => {
    const user = userEvent.setup();
    const api = membersApi([olive, alice, bob]);
    render(
      <OrganizationMembersPage
        organization={studio("admin")}
        api={api as unknown as ApiClient}
        currentUserId="alice"
        onLeft={vi.fn()}
      />,
      { wrapper }
    );
    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(4);
    const oliveRow = rows[1];
    expect(within(oliveRow).getByText("Owner")).toBeVisible();
    expect(within(oliveRow).queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove Alice" })
    ).not.toBeInTheDocument();
    // Your own row is read-only; you change your access by leaving.
    expect(
      screen.queryByRole("combobox", { name: "Role for alice@example.com" })
    ).not.toBeInTheDocument();
    // Admins can't promote anyone to owner.
    expect(
      within(
        screen.getByRole("combobox", { name: "Role for bob@example.com" })
      ).queryByRole("option", { name: "Owner" })
    ).not.toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Role for bob@example.com" }),
      "admin"
    );
    await waitFor(() =>
      expect(api.updateOrganizationMember).toHaveBeenCalledWith(
        "organization-1",
        "bob",
        "admin"
      )
    );
    await user.click(screen.getByRole("button", { name: "Remove Bob" }));
    await waitFor(() =>
      expect(screen.queryByText("bob@example.com")).not.toBeInTheDocument()
    );
  });

  it("shows members read-only to members and lets them leave", async () => {
    const user = userEvent.setup();
    const api = membersApi([olive, bob]);
    const onLeft = vi.fn();
    render(
      <OrganizationMembersPage
        organization={studio("member")}
        api={api as unknown as ApiClient}
        currentUserId="bob"
        onLeft={onLeft}
      />,
      { wrapper }
    );
    expect(await screen.findByText("(you)")).toBeVisible();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Leave organization" })
    );
    await waitFor(() => expect(onLeft).toHaveBeenCalled());
    expect(api.leaveOrganization).toHaveBeenCalledWith("organization-1");
  });

  it("shows a load error with Retry", async () => {
    const user = userEvent.setup();
    const api = membersApi([]);
    api.listOrganizationMembers
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ members: [olive] });
    render(
      <OrganizationMembersPage
        organization={studio("owner")}
        api={api as unknown as ApiClient}
        currentUserId="olive"
        onLeft={vi.fn()}
      />,
      { wrapper }
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We couldn’t load the members."
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("olive@example.com")).toBeVisible();
  });
});

describe("OrganizationSettingsPage", () => {
  it("saves general details and deletes the organization after confirmation", async () => {
    const user = userEvent.setup();
    const onUpdated = vi.fn();
    const onDeleted = vi.fn();
    const api = {
      updateOrganization: vi.fn(async (_id: string, input: object) => ({
        ...studio("owner"),
        ...input
      })),
      deleteOrganization: vi.fn(async () => undefined)
    };
    render(
      <OrganizationSettingsPage
        organization={studio("owner")}
        api={api as unknown as ApiClient}
        onUpdated={onUpdated}
        onDeleted={onDeleted}
      />
    );
    expect(screen.queryByText("Members")).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Studio Two");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(api.updateOrganization).toHaveBeenCalledWith("organization-1", {
        name: "Studio Two",
        slug: "studio"
      })
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Organization saved."
    );

    await user.click(
      screen.getByRole("button", { name: "Delete organization" })
    );
    const dialog = await screen.findByRole("dialog");
    expect(api.deleteOrganization).not.toHaveBeenCalled();
    await user.type(within(dialog).getByRole("textbox"), "Studio");
    await user.click(within(dialog).getByRole("button", { name: /Delete/ }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  });

  it("is read-only for members and hides the danger zone from non-owners", () => {
    render(
      <OrganizationSettingsPage
        organization={studio("member")}
        api={{} as ApiClient}
        onUpdated={vi.fn()}
        onDeleted={vi.fn()}
      />
    );
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(
      screen.getByText("You have read-only access to organization settings.")
    ).toBeVisible();
    expect(screen.queryByText("Danger zone")).not.toBeInTheDocument();
  });
});
