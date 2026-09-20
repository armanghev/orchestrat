import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { organization, project } from "@/test/factories";
import type { ApiClient } from "@/lib/api/client";
import { loadProjectCatalog } from "@/features/hierarchy/catalog";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TopToolbar } from "./top-toolbar";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/platform/provider", () => ({
  usePlatform: () => ({ kind: "desktop" })
}));
vi.mock("@/features/theme/theme-provider", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() })
}));

it("switches organizations, scopes project choices, and keeps empty organizations accessible", async () => {
  const user = userEvent.setup();
  const acme = organization({ name: "Acme" });
  const other = organization({
    id: "00000000-0000-4000-8000-000000000011",
    name: "Other"
  });
  const empty = organization({
    id: "00000000-0000-4000-8000-000000000012",
    name: "Empty"
  });
  const alpha = project({ name: "Alpha", organization_id: acme.id });
  const beta = project({
    id: "00000000-0000-4000-8000-000000000021",
    name: "Beta",
    organization_id: acme.id
  });
  const gamma = project({
    id: "00000000-0000-4000-8000-000000000022",
    name: "Gamma",
    organization_id: other.id
  });
  const catalog = await loadProjectCatalog(new QueryClient(), {
    listOrganizations: async () => ({ organizations: [acme, other, empty] }),
    listProjects: async (id: string) => ({
      projects: [alpha, beta, gamma].filter(
        (item) => item.organization_id === id
      )
    })
  } as ApiClient);
  const selectProject = vi.fn();
  function Harness() {
    const [projectId, setProjectId] = useState(alpha.id);
    return (
      <SidebarProvider>
        <TopToolbar
          catalog={catalog}
          context={catalog.projects.find(
            ({ project }) => project.id === projectId
          )}
          collapsed={false}
          onOpenCommands={vi.fn()}
          onSelectProject={(id) => {
            selectProject(id);
            setProjectId(id);
          }}
        />
      </SidebarProvider>
    );
  }
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "Project: Alpha" }));
  expect(screen.getByRole("menuitemradio", { name: "Alpha" })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  expect(
    screen.queryByRole("menuitemradio", { name: "Gamma" })
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("menuitemradio", { name: "Beta" }));
  expect(selectProject).toHaveBeenLastCalledWith(beta.id);

  await user.click(screen.getByRole("button", { name: "Organization: Acme" }));
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
  await user.click(screen.getByRole("menuitemradio", { name: "Other" }));
  expect(selectProject).toHaveBeenLastCalledWith(gamma.id);
  await user.click(screen.getByRole("button", { name: "Project: Gamma" }));
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
  expect(screen.getByRole("menuitemradio", { name: "Gamma" })).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await user.click(screen.getByRole("menuitem", { name: "Project settings" }));
  expect(navigate).toHaveBeenLastCalledWith({
    to: "/projects/$projectId/settings",
    params: { projectId: gamma.id }
  });

  await user.click(screen.getByRole("button", { name: "Organization: Other" }));
  await user.click(
    screen.getByRole("menuitem", { name: "Organization settings" })
  );
  expect(navigate).toHaveBeenLastCalledWith({
    to: "/organizations/$organizationId/settings",
    params: { organizationId: other.id }
  });

  await user.click(screen.getByRole("button", { name: "Organization: Other" }));
  await user.click(screen.getByRole("menuitemradio", { name: "Empty" }));
  expect(navigate).toHaveBeenCalledWith({
    to: "/organizations/$organizationId/settings",
    params: { organizationId: empty.id }
  });
});
