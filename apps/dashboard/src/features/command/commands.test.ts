import { describe, expect, it, vi } from "vitest";
import { buildCommands } from "./commands";
import type { ProjectCatalog } from "@/features/hierarchy/catalog";
import { branch, organization, project } from "@/test/factories";

const alpha = project({ name: "Alpha" });
const beta = project({ name: "Beta" });
alpha.id = "alpha";
beta.id = "beta";
const catalog: ProjectCatalog = {
  organizations: [
    organization({ name: "Acme" }),
    organization({ name: "Beta Org" })
  ],
  failures: [],
  projects: [
    {
      organization: organization({ name: "Acme" }),
      project: alpha
    },
    {
      organization: organization({ name: "Beta Org" }),
      project: beta
    }
  ]
};

describe("buildCommands", () => {
  it("exposes only supported project, navigation, appearance, and application commands", () => {
    const commands = buildCommands({
      catalog,
      activeProjectId: "alpha",
      navigateToProject: vi.fn(),
      navigateToRoute: vi.fn(),
      setTheme: vi.fn(),
      toggleSidebar: vi.fn(),
      openPreferences: vi.fn(),
      signOut: vi.fn()
    });
    expect(commands.map((command) => command.id)).toEqual([
      "project:alpha",
      "project:beta",
      "navigate:overview",
      "navigate:tasks",
      "navigate:agents",
      "navigate:documents",
      "navigate:messages",
      "navigate:activity",
      "navigate:decisions",
      "navigate:settings",
      "theme:system",
      "theme:light",
      "theme:dark",
      "sidebar:toggle",
      "preferences:open",
      "auth:sign-out"
    ]);
    expect(commands.map((command) => command.label).join(" ")).not.toMatch(
      /Create Task|Connect Agent|Send Message/
    );
  });

  it("uses hierarchy terms for projects and routes within the active project", () => {
    const navigateToRoute = vi.fn();
    const commands = buildCommands({
      catalog,
      activeProjectId: "alpha",
      navigateToProject: vi.fn(),
      navigateToRoute,
      setTheme: vi.fn(),
      toggleSidebar: vi.fn(),
      openPreferences: vi.fn(),
      signOut: vi.fn()
    });

    expect(
      commands.find((command) => command.id === "project:alpha")?.keywords
    ).toEqual(
      expect.arrayContaining(["project", "organization", "Alpha", "Acme"])
    );
    commands.find((command) => command.id === "navigate:tasks")?.run();
    expect(navigateToRoute).toHaveBeenCalledWith("tasks", "alpha");
  });

  it("switches branches and creates one from the Branches group", () => {
    const main = branch();
    const feature = branch({
      id: "00000000-0000-4000-8000-000000000051",
      name: "feat/checkout",
      is_default: false
    });
    const archived = branch({
      id: "00000000-0000-4000-8000-000000000052",
      name: "feat/old",
      is_default: false,
      archived_at: "2026-09-27T00:00:00.000Z",
      archived_reason: "manual"
    });
    const selectBranch = vi.fn();
    const openCreateBranch = vi.fn();
    const commands = buildCommands({
      catalog,
      activeProjectId: "alpha",
      navigateToProject: vi.fn(),
      navigateToRoute: vi.fn(),
      setTheme: vi.fn(),
      toggleSidebar: vi.fn(),
      openPreferences: vi.fn(),
      signOut: vi.fn(),
      branches: {
        branches: [main, feature, archived],
        currentBranchId: main.id,
        canCreate: true,
        selectBranch,
        openCreateBranch
      }
    });
    const branchCommands = commands.filter(
      (command) => command.group === "Branches"
    );
    // The current and archived branches aren't offered.
    expect(branchCommands.map((command) => command.id)).toEqual([
      `branch:${feature.id}`,
      "branch:new"
    ]);
    expect(branchCommands[0]?.label).toBe("Switch to branch feat/checkout");
    branchCommands[0]?.run();
    expect(selectBranch).toHaveBeenCalledWith(feature.id);
    branchCommands[1]?.run();
    expect(openCreateBranch).toHaveBeenCalledOnce();

    const archivedProject = buildCommands({
      catalog,
      activeProjectId: "alpha",
      navigateToProject: vi.fn(),
      navigateToRoute: vi.fn(),
      setTheme: vi.fn(),
      toggleSidebar: vi.fn(),
      openPreferences: vi.fn(),
      signOut: vi.fn(),
      branches: {
        branches: [main, feature],
        currentBranchId: main.id,
        canCreate: false,
        selectBranch,
        openCreateBranch
      }
    });
    expect(archivedProject.some((command) => command.id === "branch:new")).toBe(
      false
    );
  });
});
