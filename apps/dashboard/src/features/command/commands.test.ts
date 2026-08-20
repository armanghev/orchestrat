import { describe, expect, it, vi } from "vitest";
import { buildCommands } from "./commands";
import type { ProjectCatalog } from "@/features/hierarchy/catalog";
import { organization, project } from "@/test/factories";

const alpha = project({ name: "Alpha" });
const beta = project({ name: "Beta" });
alpha.id = "alpha";
beta.id = "beta";
const catalog: ProjectCatalog = {
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
      "navigate:integrations",
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
});
