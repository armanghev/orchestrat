import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { apiUrl, render } from "@/test/branch-routes";
import { organization } from "@/test/factories";
import { handlers } from "@/test/handlers";
import { hierarchyKeys } from "@/features/hierarchy/query-options";

const empty = http.get(`${apiUrl}/organizations`, () =>
  HttpResponse.json({ organizations: [] })
);
const field = () => screen.getByRole("textbox", { name: "Organization slug" });

async function fill(name = "Café & Déjà Vu!") {
  const input = await screen.findByRole("textbox", {
    name: "Organization name"
  });
  fireEvent.change(input, { target: { value: name } });
  return input;
}

describe("create organization", () => {
  it("derives a slug and keeps an edited slug when the name changes", async () => {
    await render("/organizations/new", [empty]);
    const name = await fill();
    expect(field()).toHaveValue("cafe-deja-vu");
    expect(screen.getByText("org/")).toBeVisible();
    fireEvent.change(field(), { target: { value: "studio" } });
    fireEvent.change(name, { target: { value: "A new name" } });
    expect(field()).toHaveValue("studio");
    expect(
      screen.queryByRole("link", { name: /^Back to/ })
    ).not.toBeInTheDocument();
  });

  it("validates both fields before submitting", async () => {
    const post = vi.fn(() => HttpResponse.json(organization()));
    await render("/organizations/new", [
      empty,
      http.post(`${apiUrl}/organizations`, post)
    ]);
    await screen.findByRole("textbox", { name: "Organization name" });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Create organization" })
    );
    expect(screen.getByText(/Enter an organization name/)).toBeVisible();
    await fill("Acme");
    fireEvent.change(field(), { target: { value: "Bad Slug" } });
    await user.click(
      screen.getByRole("button", { name: "Create organization" })
    );
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Use 1–63 lowercase/)).toBeVisible();
    expect(post).not.toHaveBeenCalled();
  });

  it("shows a duplicate slug inline and keeps the draft for a corrected retry", async () => {
    const post = vi.fn(() =>
      HttpResponse.json(
        {
          error: {
            code: "ORGANIZATION_SLUG_TAKEN",
            message: "Already taken",
            details: { field: "slug" },
            request_id: "req_1"
          }
        },
        { status: 409 }
      )
    );
    await render("/organizations/new", [
      empty,
      http.post(`${apiUrl}/organizations`, post)
    ]);
    const name = await fill("Acme Studio");
    await userEvent.click(
      screen.getByRole("button", { name: "Create organization" })
    );
    expect(
      await screen.findByText("This slug is already taken. Choose another.")
    ).toBeVisible();
    expect(name).toHaveValue("Acme Studio");
    expect(field()).toHaveValue("acme-studio");
    expect(field()).toHaveFocus();
    fireEvent.change(field(), { target: { value: "acme-studio-2" } });
    expect(
      screen.queryByText("This slug is already taken. Choose another.")
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Create organization" })
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText("This slug is already taken. Choose another.")
    ).toBeVisible();
  });

  it("submits the edited slug, invalidates cached hierarchy and opens project creation", async () => {
    const created = organization({
      id: "00000000-0000-4000-8000-000000000090",
      name: "Acme Studio",
      slug: "custom-studio"
    });
    let saved = false;
    const view = await render("/organizations/new", [
      http.get(`${apiUrl}/organizations`, () =>
        HttpResponse.json({ organizations: saved ? [created] : [] })
      ),
      http.post(`${apiUrl}/organizations`, async ({ request }) => {
        expect(await request.json()).toEqual({
          name: "Acme Studio",
          slug: "custom-studio"
        });
        saved = true;
        return HttpResponse.json(created, { status: 201 });
      }),
      http.get(`${apiUrl}/organizations/:organizationId/projects`, () =>
        HttpResponse.json({ projects: [] })
      ),
      http.get(`${apiUrl}/repository/providers`, () =>
        HttpResponse.json({ providers: [] })
      ),
      ...handlers
    ]);
    view.queryClient.setQueryData(hierarchyKeys.catalog(), {
      organizations: [],
      projects: [],
      failures: []
    });
    await fill("Acme Studio");
    fireEvent.change(field(), { target: { value: "custom-studio" } });
    await userEvent.click(
      screen.getByRole("button", { name: "Create organization" })
    );
    await waitFor(() =>
      expect(view.router.state.location.pathname).toBe(
        `/organizations/${created.id}/projects/new`
      )
    );
    expect(
      await screen.findByRole("textbox", { name: "Project name" })
    ).toBeVisible();
    expect(
      view.queryClient.getQueryData(hierarchyKeys.organizations())
    ).toEqual({ organizations: [created] });
  });

  it("links back to the specified accessible organization with a safe fallback", async () => {
    const first = organization();
    const previous = organization({
      id: "00000000-0000-4000-8000-000000000091",
      name: "Previous studio"
    });
    const view = await render(
      `/organizations/new?fromOrganization=${previous.id}`,
      [
        http.get(`${apiUrl}/organizations`, () =>
          HttpResponse.json({ organizations: [first, previous] })
        )
      ]
    );
    expect(
      await screen.findByRole("link", { name: "Back to Previous studio" })
    ).toHaveAttribute("href", `/organizations/${previous.id}`);
    await act(() =>
      view.router.navigate({
        to: "/organizations/new",
        search: { fromOrganization: "00000000-0000-4000-8000-000000000099" }
      })
    );
    expect(
      await screen.findByRole("link", { name: `Back to ${first.name}` })
    ).toHaveAttribute("href", `/organizations/${first.id}`);
  });

  it("shows loading and retries an organization-list failure", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failed = false;
    await render("/organizations/new", [
      http.get(`${apiUrl}/organizations`, async () => {
        if (!failed) {
          await waiting;
          failed = true;
          return HttpResponse.json(
            {
              error: {
                code: "INTERNAL_ERROR",
                message: "Unavailable",
                details: {},
                request_id: "req_1"
              }
            },
            { status: 500 }
          );
        }
        return HttpResponse.json({ organizations: [] });
      })
    ]);
    expect(
      await screen.findByRole("status", { name: "Loading organizations" })
    ).toBeVisible();
    await act(async () => release());
    expect(
      await screen.findByText("Unable to load your organizations.")
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("textbox", { name: "Organization name" })
    ).toBeVisible();
  });

  it("disables submission while pending and preserves the draft after a server error", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    await render("/organizations/new", [
      empty,
      http.post(`${apiUrl}/organizations`, async () => {
        await waiting;
        return HttpResponse.json(
          {
            error: {
              code: "INTERNAL_ERROR",
              message: "Try again later.",
              details: {},
              request_id: "req_1"
            }
          },
          { status: 500 }
        );
      })
    ]);
    const name = await fill("Acme");
    await userEvent.click(
      screen.getByRole("button", { name: "Create organization" })
    );
    expect(
      screen.getByRole("button", { name: "Creating organization..." })
    ).toBeDisabled();
    expect(name).toBeDisabled();
    await act(async () => release());
    expect(await screen.findByText("Try again later.")).toBeVisible();
    expect(name).toHaveValue("Acme");
    expect(field()).toHaveValue("acme");
  });
});
