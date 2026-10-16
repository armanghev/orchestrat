import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Organization,
  OrganizationMember,
  Project,
  ProjectInvitation,
  ProjectMember
} from "@orchestrat/protocol";
import type { ApiClient } from "@/lib/api/client";
import { ProjectMembersSection } from "./project-members-section";

const organization: Organization = {
  id: "organization-1",
  name: "Studio",
  slug: "studio",
  role: "owner",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z"
};

const project: Project = {
  id: "project-1",
  organization_id: organization.id,
  name: "Launch",
  slug: "launch",
  description: null,
  status: "active",
  role: "owner",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  archived_at: null
};

const alice: OrganizationMember = {
  user_id: "alice",
  username: "alice",
  full_name: "Alice",
  email: "alice@example.com",
  avatar_url: null,
  role: "owner",
  created_at: "2026-01-01T00:00:00.000Z"
};

const bob: OrganizationMember = {
  user_id: "bob",
  username: "bob",
  full_name: "Bob",
  email: "bob@example.com",
  avatar_url: null,
  role: "member",
  created_at: "2026-01-01T00:00:00.000Z"
};

const aliceProject: ProjectMember = { ...alice, role: "owner" };
const bobProject: ProjectMember = { ...bob, role: "admin" };

const activeInvitation: ProjectInvitation = {
  id: "invite-1",
  project_id: project.id,
  created_by: alice.user_id,
  created_at: "2026-01-01T00:00:00.000Z",
  expires_at: "2099-01-08T00:00:00.000Z",
  revoked_at: null,
  accepted_at: null
};

function apiFixture(overrides: Partial<ApiClient> = {}) {
  return {
    listOrganizationMembers: vi.fn().mockResolvedValue({
      members: [alice, bob]
    }),
    listProjectMembers: vi.fn().mockResolvedValue({
      members: [aliceProject]
    }),
    listProjectInvitations: vi.fn().mockResolvedValue({ invitations: [] }),
    addProjectMember: vi.fn().mockResolvedValue(bobProject),
    updateProjectMember: vi.fn().mockResolvedValue(bobProject),
    removeProjectMember: vi.fn().mockResolvedValue({ deleted: true }),
    createProjectInvitation: vi.fn().mockResolvedValue({
      invitation: { ...activeInvitation, id: "invite-2" },
      token: "a".repeat(43)
    }),
    revokeProjectInvitation: vi.fn().mockResolvedValue({
      invitation: {
        ...activeInvitation,
        revoked_at: "2026-01-02T00:00:00.000Z"
      }
    }),
    ...overrides
  } as unknown as ApiClient;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ProjectMembersSection", () => {
  it("adds an existing organization member at the selected project role", async () => {
    const user = userEvent.setup();
    const api = apiFixture();
    render(
      <ProjectMembersSection
        project={project}
        organization={organization}
        api={api}
      />
    );

    await screen.findByText("Alice");
    await user.selectOptions(
      screen.getByLabelText("Organization member"),
      bob.user_id
    );
    await user.selectOptions(screen.getByLabelText("Role"), "admin");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(api.addProjectMember).toHaveBeenCalledWith(project.id, {
        user_id: bob.user_id,
        role: "admin"
      })
    );
    expect(await screen.findByText("Bob")).toBeVisible();
  });

  it("creates a copyable public invitation link and revokes active links", async () => {
    const user = userEvent.setup();
    const api = apiFixture({
      listProjectInvitations: vi.fn().mockResolvedValue({
        invitations: [activeInvitation]
      })
    });
    render(
      <ProjectMembersSection
        project={project}
        organization={organization}
        api={api}
      />
    );

    await screen.findByText("Active");
    await user.click(
      screen.getByRole("button", { name: "Create invitation link" })
    );
    const link = await screen.findByLabelText("Invitation link");
    expect(link).toHaveValue(
      `${window.location.origin}/project-invitations/join#token=` +
        "a".repeat(43)
    );

    await user.click(screen.getAllByRole("button", { name: "Revoke" })[0]!);
    await waitFor(() =>
      expect(api.revokeProjectInvitation).toHaveBeenCalledWith(
        project.id,
        activeInvitation.id
      )
    );
    expect(screen.getByText("Revoked")).toBeVisible();
  });

  it("uses the project role to keep organization owners from editing a project roster", async () => {
    const api = apiFixture();
    render(
      <ProjectMembersSection
        project={{ ...project, role: "member" }}
        organization={organization}
        api={api}
      />
    );

    await screen.findByText("Alice");
    expect(
      screen.getByText(/only project owners and admins can manage/i)
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Create invitation link" })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Role for alice@example.com")).toBeDisabled();
    expect(screen.getByLabelText("Role for alice@example.com")).toHaveValue(
      "owner"
    );
  });

  it("refreshes project access after the current owner demotes their own role", async () => {
    const user = userEvent.setup();
    const onMembershipChanged = vi.fn(async () => undefined);
    const api = apiFixture({
      updateProjectMember: vi
        .fn()
        .mockResolvedValue({ ...aliceProject, role: "member" })
    });
    const view = render(
      <ProjectMembersSection
        project={project}
        organization={organization}
        api={api}
        onMembershipChanged={onMembershipChanged}
      />
    );

    await screen.findByText("Alice");
    await user.selectOptions(
      screen.getByLabelText("Role for alice@example.com"),
      "member"
    );
    await waitFor(() => expect(onMembershipChanged).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByLabelText("Role for alice@example.com")).toHaveValue(
        "member"
      )
    );

    view.rerender(
      <ProjectMembersSection
        project={{ ...project, role: "member" }}
        organization={organization}
        api={api}
        onMembershipChanged={onMembershipChanged}
      />
    );
    expect(
      await screen.findByText(/only project owners and admins can manage/i)
    ).toBeVisible();
  });
});
