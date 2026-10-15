import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "@orchestrat/protocol";
import { Auth, apiUrl, platform, render } from "@/test/branch-routes";
import { organization, project } from "@/test/factories";
import { handlers } from "@/test/handlers";
import { renderDashboardRoute } from "@/test/render";
import { filterOrganizationProjects } from "./organization-home-page";

const org = organization();

function summary(
  overrides: Partial<ProjectSummary> & { name: string; id: string }
): ProjectSummary {
  const base = project({
    id: overrides.id,
    name: overrides.name,
    organization_id: org.id,
    slug: overrides.name.toLowerCase().replaceAll(" ", "-"),
    status: overrides.status ?? "active",
    description: overrides.description ?? null,
    role: overrides.role ?? "owner",
    archived_at:
      overrides.status === "archived" ? "2026-01-02T00:00:00.000Z" : null
  });
  return {
    ...base,
    task_key_prefix: overrides.task_key_prefix ?? "ORC",
    default_branch_name: overrides.default_branch_name ?? "main",
    member_count: overrides.member_count ?? 2,
    open_task_count: overrides.open_task_count ?? 3,
    last_activity_at:
      overrides.last_activity_at === undefined
        ? "2026-01-03T00:00:00.000Z"
        : overrides.last_activity_at,
    repository:
      overrides.repository === undefined ? null : overrides.repository,
    ...overrides
  };
}

const alpha = summary({
  id: "00000000-0000-4000-8000-000000000010",
  name: "Alpha",
  task_key_prefix: "ALP",
  last_activity_at: "2026-01-05T00:00:00.000Z",
  description: "First project"
});
const beta = summary({
  id: "00000000-0000-4000-8000-000000000011",
  name: "Beta",
  task_key_prefix: "BET",
  last_activity_at: "2026-01-04T00:00:00.000Z",
  repository: {
    provider: "github",
    full_name: "acme/beta",
    status: "active"
  }
});
const archived = summary({
  id: "00000000-0000-4000-8000-000000000012",
  name: "Zulu",
  status: "archived",
  task_key_prefix: "ZUL",
  last_activity_at: "2026-01-01T00:00:00.000Z"
});

function summariesHandler(projects: ProjectSummary[]) {
  return http.get(
    `${apiUrl}/organizations/:organizationId/project-summaries`,
    () => HttpResponse.json({ projects })
  );
}

describe("filterOrganizationProjects", () => {
  it("filters, searches, and sorts", () => {
    const all = [alpha, beta, archived];
    expect(
      filterOrganizationProjects(
        all,
        { sort: "recent", filter: "active" },
        ""
      ).map((item) => item.name)
    ).toEqual(["Alpha", "Beta"]);
    expect(
      filterOrganizationProjects(
        all,
        { sort: "name", filter: "archived" },
        ""
      ).map((item) => item.name)
    ).toEqual(["Zulu"]);
    expect(
      filterOrganizationProjects(
        all,
        { sort: "name", filter: "active" },
        "bet"
      ).map((item) => item.name)
    ).toEqual(["Beta"]);
  });
});

describe("OrganizationHomePage", () => {
  it("renders project cards from summaries", async () => {
    await render(`/organizations/${org.id}`, [
      summariesHandler([alpha, beta]),
      ...handlers
    ]);
    expect(
      await screen.findByRole("link", { name: "Alpha" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Beta" })).toBeInTheDocument();
    expect(screen.getByText("ALP")).toBeVisible();
    expect(screen.getByText("acme/beta")).toBeVisible();
    expect(screen.getByRole("link", { name: "No repository" })).toHaveAttribute(
      "href",
      expect.stringContaining("/settings#repository")
    );
  });

  it("searches and sorts the grid", async () => {
    await render(`/organizations/${org.id}`, [
      summariesHandler([alpha, beta]),
      ...handlers
    ]);
    await screen.findByRole("link", { name: "Alpha" });
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Sort projects" }),
      "name"
    );
    const section = screen.getByRole("region", {
      name: `${org.name} projects`
    });
    const names = within(section)
      .getAllByRole("link")
      .map((link) => link.getAttribute("aria-label"))
      .filter(
        (name): name is string => Boolean(name) && name !== "No repository"
      );
    expect(names).toEqual(["Alpha", "Beta"]);

    fireEvent.change(screen.getByPlaceholderText("Search projects"), {
      target: { value: "Beta" }
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("link", { name: "Alpha" })
      ).not.toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: "Beta" })).toBeInTheDocument();
  });

  it("shows the empty state when there are no projects", async () => {
    await render(`/organizations/${org.id}`, [
      summariesHandler([]),
      ...handlers
    ]);
    expect(await screen.findByText("No projects yet")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Create project" })
    ).toBeVisible();
  });

  it("shows an error with retry", async () => {
    let attempts = 0;
    await render(`/organizations/${org.id}`, [
      http.get(
        `${apiUrl}/organizations/:organizationId/project-summaries`,
        () => {
          attempts += 1;
          if (attempts === 1)
            return HttpResponse.json(
              {
                error: {
                  code: "INTERNAL_ERROR",
                  message: "boom",
                  details: {},
                  request_id: "req_1"
                }
              },
              { status: 500 }
            );
          return HttpResponse.json({ projects: [alpha] });
        }
      ),
      ...handlers
    ]);
    expect(
      await screen.findByText("We couldn’t load the projects.")
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: "Alpha" })).toBeVisible();
  });

  it("persists sort and filter in preferences", async () => {
    const store = {
      load: async () => null,
      save: async () => undefined
    };
    await renderDashboardRoute({
      path: `/organizations/${org.id}`,
      auth: new Auth({ status: "signedIn", identityKey: "user" }),
      platform: { ...platform(), preferences: store },
      handlers: [summariesHandler([alpha, archived]), ...handlers],
      preferences: {
        organizationProjectsViews: {
          [org.id]: { sort: "name", filter: "archived" }
        }
      }
    });
    expect(await screen.findByRole("link", { name: "Zulu" })).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Alpha" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Sort projects" })).toHaveValue(
      "name"
    );
    expect(
      screen.getByRole("combobox", { name: "Filter projects" })
    ).toHaveValue("archived");

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Filter projects" }),
      "active"
    );
    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Alpha" })).toBeVisible();
    });
    expect(
      screen.queryByRole("link", { name: "Zulu" })
    ).not.toBeInTheDocument();
  });
});
