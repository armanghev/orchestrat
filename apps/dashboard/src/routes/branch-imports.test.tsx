import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Decision, MergePreviewItem } from "@orchestrat/protocol";
import { branchKeys } from "@/features/branches/query-options";
import { branch, project } from "@/test/factories";
import {
  apiUrl,
  branchHandlers,
  feature,
  main,
  old,
  projectId,
  render
} from "@/test/branch-routes";

// Onboarding, the import dialog and Decisions (docs/project-branches.md
// §11.6, §11.7).

const key = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pending = branch({
  id: "00000000-0000-4000-8000-000000000054",
  name: "feat/search",
  is_default: false,
  name_source: "cli",
  created_via: "agent",
  onboarding_state: "pending"
});

function item(
  n: number,
  overrides: Partial<MergePreviewItem> = {}
): MergePreviewItem {
  return {
    item_type: "task",
    lineage_key: key(n),
    source_id: key(n),
    target_id: null,
    outcome: "copy",
    reason: null,
    fields: [],
    required_by: [],
    label: `Task ${n}`,
    task_key: null,
    audience: null,
    source_values: null,
    target_values: null,
    ...overrides
  };
}

const schema = item(101, {
  label: "Schema",
  task_key: "DASH-1",
  required_by: [key(102)]
});
const endpoint = item(102, { label: "API", task_key: "DASH-2" });
const conflict = (n: number, label: string, target = "Ours") =>
  item(n, {
    item_type: "document",
    label,
    target_id: key(n + 50),
    outcome: "conflict",
    reason: "changed_on_both",
    fields: ["body"],
    source_values: { body: "Theirs" },
    target_values: { body: target }
  });
const readme = conflict(103, "README.md");
const notes = conflict(104, "notes.md");
const review = item(105, {
  item_type: "chat",
  label: "Design review",
  outcome: "skipped",
  reason: "audience_would_widen",
  audience: [
    { type: "human", id: key(201), name: "Arman" },
    { type: "agent", id: key(202), name: "claude" }
  ]
});
const standup = item(106, {
  item_type: "chat",
  label: "Standup",
  audience: [
    { type: "human", id: key(203), name: "Test User" },
    { type: "agent", id: key(204), name: "codex" }
  ]
});

type Selection = { tasks: string[]; documents: string[]; chats: string[] };

/** A preview API: everything for `"all"`, otherwise the chosen items plus
 * the tasks they require. A function catalog can change between previews. */
function previewHandler(
  items: MergePreviewItem[] | (() => MergePreviewItem[]),
  fingerprint: (selection: Selection) => string
) {
  return http.post(
    `${apiUrl}/projects/:projectId/merges/preview`,
    async ({ request }) => {
      const body = (await request.json()) as {
        selection: Selection | { tasks: "all" };
      };
      const catalog = typeof items === "function" ? items() : items;
      const all = body.selection.tasks === "all";
      const selection = body.selection as Selection;
      const chosen = (candidate: MergePreviewItem) =>
        all ||
        (candidate.item_type === "task"
          ? selection.tasks.includes(candidate.lineage_key) ||
            candidate.required_by.some((dependent) =>
              selection.tasks.includes(dependent)
            )
          : candidate.item_type === "document"
            ? selection.documents.includes(candidate.lineage_key)
            : selection.chats.includes(candidate.lineage_key));
      return HttpResponse.json({
        preview: {
          fingerprint: all ? "f".repeat(64) : fingerprint(selection),
          kind: "import",
          source_branch_id: main.id,
          target_branch_id: pending.id,
          items: catalog.filter(chosen),
          counts: {}
        }
      });
    }
  );
}

const run = (overrides = {}) => ({
  id: key(301),
  project_id: projectId,
  source_branch_id: main.id,
  target_branch_id: pending.id,
  kind: "import",
  trigger: "dashboard",
  status: "applied",
  skip_reason: null,
  provider: null,
  counts: { "task.copy": 2, "document.apply": 1 },
  skipped: [],
  decision_count: 0,
  created_by: null,
  created_at: "2026-09-30T00:00:00.000Z",
  applied_at: "2026-09-30T00:00:00.000Z",
  ...overrides
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("branch onboarding and imports", () => {
  it("starts a new branch blank and keeps what agents made", async () => {
    let current = pending;
    let posted: unknown;
    await render(`/projects/${projectId}/tasks?branch=${pending.id}`, [
      http.get(`${apiUrl}/projects/:projectId/branches`, () =>
        HttpResponse.json({ branches: [main, feature, current] })
      ),
      http.post(
        `${apiUrl}/projects/:projectId/branches/:branchId/onboarding`,
        async ({ request }) => {
          posted = await request.json();
          current = { ...pending, onboarding_state: "completed" };
          return HttpResponse.json({ branch: current });
        }
      ),
      ...branchHandlers()
    ]);
    const panel = await screen.findByRole("region", {
      name: "Set up feat/search"
    });
    await waitFor(() =>
      expect(panel).toHaveTextContent("1 task already here will be kept.")
    );
    expect(
      within(panel).getByRole("radio", { name: "Start blank" })
    ).toBeChecked();
    const user = userEvent.setup();
    await user.click(within(panel).getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Set up feat/search" })
      ).not.toBeInTheDocument()
    );
    expect(posted).toEqual({ choice: "blank" });
  });

  it("locks required tasks and needs a choice for every conflict", async () => {
    let applied: Record<string, unknown> | undefined;
    await render(`/projects/${projectId}/tasks?branch=${pending.id}`, [
      previewHandler([schema, endpoint, readme, review, standup], (selection) =>
        (selection.documents.length ? "d" : "e").repeat(64)
      ),
      http.post(`${apiUrl}/projects/:projectId/merges`, async ({ request }) => {
        applied = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ run: run() }, { status: 201 });
      }),
      ...branchHandlers({ branches: [main, feature, pending] })
    ]);
    const user = userEvent.setup();
    const panel = await screen.findByRole("region", {
      name: "Set up feat/search"
    });
    await user.click(within(panel).getByRole("radio", { name: "Pick items…" }));
    await user.click(within(panel).getByRole("button", { name: "Continue" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Import into feat/search"
    });
    const api = await within(dialog).findByRole("checkbox", {
      name: /DASH-2/
    });
    const schemaBox = within(dialog).getByRole("checkbox", { name: /DASH-1/ });
    expect(api).not.toBeChecked();
    expect(schemaBox).not.toBeChecked();
    await user.click(api);
    // DASH-2 needs DASH-1, so it comes along and stays while DASH-2 does.
    expect(schemaBox).toBeChecked();
    expect(schemaBox).toBeDisabled();
    expect(dialog).toHaveTextContent("Required by DASH-2");

    await user.click(within(dialog).getByRole("tab", { name: /Chats/ }));
    const widen = within(dialog).getByRole("checkbox", {
      name: /Design review/
    });
    expect(widen).toBeDisabled();
    expect(dialog).toHaveTextContent("More people would see this conversation");
    expect(dialog).toHaveTextContent("Visible to Test User, codex");

    await user.click(within(dialog).getByRole("tab", { name: /Documents/ }));
    await user.click(
      within(dialog).getByRole("checkbox", { name: /README\.md/ })
    );
    expect(await within(dialog).findByText("Conflicts (1)")).toBeVisible();
    // Conflicts are explicit: nothing is chosen and Import waits.
    const keep = within(dialog).getByRole("radiogroup", {
      name: "Version to keep for README.md"
    });
    expect(
      within(keep).getByRole("radio", { name: /Use source/ })
    ).not.toBeChecked();
    expect(
      within(keep).getByRole("radio", { name: /Use target/ })
    ).not.toBeChecked();
    expect(
      within(dialog).getByRole("button", { name: "Import" })
    ).toBeDisabled();
    expect(dialog).toHaveTextContent(
      "Choose a version for 1 more conflict to import."
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Use target for all" })
    );
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Import" })
      ).toBeEnabled()
    );
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(
      await screen.findByText("Imported into feat/search from main.")
    ).toBeVisible();
    expect(
      screen.getByText("Undo isn’t available; nothing was deleted.")
    ).toBeVisible();
    expect(applied).toEqual({
      source_branch_id: main.id,
      target_branch_id: pending.id,
      kind: "import",
      // Only what was chosen: the API adds required tasks itself.
      selection: {
        tasks: [endpoint.lineage_key],
        documents: [readme.lineage_key],
        chats: []
      },
      choices: { [readme.lineage_key]: "use_target" },
      preview_fingerprint: "d".repeat(64),
      complete_onboarding: true
    });
  });

  it("keeps selections and still-valid choices after a stale preview", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await render(`/projects/${projectId}/tasks?branch=${pending.id}`, [
      previewHandler([schema, endpoint, readme, notes, standup], () =>
        "a".repeat(64)
      ),
      http.post(`${apiUrl}/projects/:projectId/merges`, async ({ request }) => {
        bodies.push((await request.json()) as Record<string, unknown>);
        if (bodies.length === 1)
          return HttpResponse.json(
            {
              error: {
                code: "BRANCH_PREVIEW_STALE",
                message: "The branches changed since the preview.",
                request_id: "req_1",
                details: {
                  preview: {
                    fingerprint: "b".repeat(64),
                    kind: "import",
                    source_branch_id: main.id,
                    target_branch_id: pending.id,
                    // notes.md changed on the target; README.md didn't.
                    items: [
                      schema,
                      endpoint,
                      readme,
                      conflict(104, "notes.md", "Ours, edited"),
                      standup
                    ],
                    counts: {}
                  }
                }
              }
            },
            { status: 409 }
          );
        return HttpResponse.json({ run: run() }, { status: 201 });
      }),
      ...branchHandlers({ branches: [main, feature, pending] })
    ]);
    const user = userEvent.setup();
    const panel = await screen.findByRole("region", {
      name: "Set up feat/search"
    });
    await user.click(
      within(panel).getByRole("radio", { name: "Import everything from" })
    );
    await user.click(within(panel).getByRole("button", { name: "Continue" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Import into feat/search"
    });
    expect(await within(dialog).findByText("Conflicts (2)")).toBeVisible();
    const versions = (name: string) =>
      within(dialog).getByRole("radiogroup", {
        name: `Version to keep for ${name}`
      });
    await user.click(
      within(versions("README.md")).getByRole("radio", { name: /Use source/ })
    );
    await user.click(
      within(versions("notes.md")).getByRole("radio", { name: /Use target/ })
    );
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(
      await within(dialog).findByText(
        "Things changed while you were choosing. The preview is refreshed and your selections were kept."
      )
    ).toBeVisible();
    expect(
      within(versions("README.md")).getByRole("radio", { name: /Use source/ })
    ).toBeChecked();
    expect(
      within(versions("notes.md")).getByRole("radio", { name: /Use target/ })
    ).not.toBeChecked();
    expect(versions("notes.md").closest("li")).toHaveAttribute(
      "data-changed",
      "true"
    );
    expect(
      within(dialog).getByRole("button", { name: "Import" })
    ).toBeDisabled();
    await user.click(
      within(versions("notes.md")).getByRole("radio", { name: /Use source/ })
    );
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(
      await screen.findByText("Imported into feat/search from main.")
    ).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({
      selection: {
        tasks: [schema.lineage_key, endpoint.lineage_key].sort(),
        documents: [readme.lineage_key, notes.lineage_key].sort(),
        chats: [standup.lineage_key]
      },
      choices: {
        [readme.lineage_key]: "use_source",
        [notes.lineage_key]: "use_source"
      },
      preview_fingerprint: "b".repeat(64)
    });
  });

  it("clears a choice whose conflict changed while the plan refreshed on its own", async () => {
    let notesTarget = "Ours";
    const bodies: Array<Record<string, unknown>> = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const view = await render(
      `/projects/${projectId}/tasks?branch=${pending.id}`,
      [
        previewHandler(
          () => [
            schema,
            endpoint,
            readme,
            conflict(104, "notes.md", notesTarget),
            standup
          ],
          () => (notesTarget === "Ours" ? "a" : "b").repeat(64)
        ),
        http.post(
          `${apiUrl}/projects/:projectId/merges`,
          async ({ request }) => {
            bodies.push((await request.json()) as Record<string, unknown>);
            await held;
            return HttpResponse.json({ run: run() }, { status: 201 });
          }
        ),
        ...branchHandlers({ branches: [main, feature, pending] })
      ]
    );
    const user = userEvent.setup();
    const panel = await screen.findByRole("region", {
      name: "Set up feat/search"
    });
    await user.click(
      within(panel).getByRole("radio", { name: "Import everything from" })
    );
    await user.click(within(panel).getByRole("button", { name: "Continue" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Import into feat/search"
    });
    expect(await within(dialog).findByText("Conflicts (2)")).toBeVisible();
    const versions = (name: string) =>
      within(dialog).getByRole("radiogroup", {
        name: `Version to keep for ${name}`
      });
    await user.click(
      within(versions("README.md")).getByRole("radio", { name: /Use source/ })
    );
    await user.click(
      within(versions("notes.md")).getByRole("radio", { name: /Use target/ })
    );
    expect(
      within(dialog).getByRole("button", { name: "Import" })
    ).toBeEnabled();

    // notes.md changes on the target and a realtime event refetches the
    // plan, with no stale import in between.
    notesTarget = "Ours, edited";
    await act(() =>
      view.queryClient.invalidateQueries({
        queryKey: branchKeys.project(projectId)
      })
    );
    await waitFor(() =>
      expect(versions("notes.md").closest("li")).toHaveAttribute(
        "data-changed",
        "true"
      )
    );
    expect(dialog).toHaveTextContent("Changed since you looked");
    expect(
      within(versions("notes.md")).getByRole("radio", { name: /Use target/ })
    ).not.toBeChecked();
    expect(
      within(versions("README.md")).getByRole("radio", { name: /Use source/ })
    ).toBeChecked();
    expect(versions("README.md").closest("li")).not.toHaveAttribute(
      "data-changed"
    );
    expect(
      within(dialog).getByRole("button", { name: "Import" })
    ).toBeDisabled();

    await user.click(
      within(versions("notes.md")).getByRole("radio", { name: /Use source/ })
    );
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    // The selection and choices are locked while the import is on its way.
    expect(
      await within(dialog).findByRole("button", { name: "Importing…" })
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("searchbox", { name: "Search items" })
    ).toBeDisabled();
    for (const box of within(dialog).getAllByRole("checkbox"))
      expect(box).toBeDisabled();
    for (const radio of within(versions("notes.md")).getAllByRole("radio"))
      expect(radio).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Use source for all" })
    ).toBeDisabled();
    release();
    expect(
      await screen.findByText("Imported into feat/search from main.")
    ).toBeVisible();
    expect(bodies).toEqual([
      expect.objectContaining({
        choices: {
          [readme.lineage_key]: "use_source",
          [notes.lineage_key]: "use_source"
        },
        preview_fingerprint: "b".repeat(64)
      })
    ]);
  });

  it("doesn't flag a conflict that's only new to the selection", async () => {
    let applied: Record<string, unknown> | undefined;
    await render(`/projects/${projectId}/tasks?branch=${pending.id}`, [
      // A different selection, a different plan.
      previewHandler([schema, endpoint, readme, notes, standup], (selection) =>
        String(selection.documents.length).repeat(64)
      ),
      http.post(`${apiUrl}/projects/:projectId/merges`, async ({ request }) => {
        applied = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ run: run() }, { status: 201 });
      }),
      ...branchHandlers({ branches: [main, feature, pending] })
    ]);
    const user = userEvent.setup();
    const panel = await screen.findByRole("region", {
      name: "Set up feat/search"
    });
    await user.click(within(panel).getByRole("radio", { name: "Pick items…" }));
    await user.click(within(panel).getByRole("button", { name: "Continue" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Import into feat/search"
    });
    await user.click(
      await within(dialog).findByRole("tab", { name: /Documents/ })
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: /README\.md/ })
    );
    expect(await within(dialog).findByText("Conflicts (1)")).toBeVisible();
    const versions = (name: string) =>
      within(dialog).getByRole("radiogroup", {
        name: `Version to keep for ${name}`
      });
    await user.click(
      within(versions("README.md")).getByRole("radio", { name: /Use source/ })
    );

    await user.click(
      within(dialog).getByRole("checkbox", { name: /notes\.md/ })
    );
    expect(await within(dialog).findByText("Conflicts (2)")).toBeVisible();
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Import" })
      ).toBeDisabled()
    );
    // notes.md has no choice yet, but nothing about it changed.
    for (const name of ["README.md", "notes.md"])
      expect(versions(name).closest("li")).not.toHaveAttribute("data-changed");
    expect(dialog).not.toHaveTextContent("Changed since you looked");
    expect(
      within(versions("README.md")).getByRole("radio", { name: /Use source/ })
    ).toBeChecked();
    for (const radio of within(versions("notes.md")).getAllByRole("radio"))
      expect(radio).not.toBeChecked();
    expect(dialog).toHaveTextContent(
      "Choose a version for 1 more conflict to import."
    );

    await user.click(
      within(versions("notes.md")).getByRole("radio", { name: /Use target/ })
    );
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(
      await screen.findByText("Imported into feat/search from main.")
    ).toBeVisible();
    expect(applied).toMatchObject({
      selection: {
        tasks: [],
        documents: [readme.lineage_key, notes.lineage_key].sort(),
        chats: []
      },
      choices: {
        [readme.lineage_key]: "use_source",
        [notes.lineage_key]: "use_target"
      },
      preview_fingerprint: "2".repeat(64)
    });
  });
});

describe("decisions", () => {
  const decision = (overrides: Partial<Decision> = {}): Decision => ({
    id: key(401),
    project_id: projectId,
    run_id: key(301),
    source_branch_id: feature.id,
    target_branch_id: main.id,
    item_type: "task",
    lineage_key: key(402),
    source_item_id: key(403),
    target_item_id: key(404),
    label: "DASH-7 Checkout copy",
    reason: "changed_on_both",
    fields: ["title"],
    source_values: { title: "Checkout copy" },
    target_values: { title: "Checkout text" },
    status: "open",
    resolved_by_user_id: null,
    resolved_at: null,
    created_at: "2026-09-30T09:00:00.000Z",
    ...overrides
  });
  const claimed = decision({
    id: key(405),
    label: "DASH-8 Payment retries",
    reason: "target_claimed"
  });
  const withDecisions = { ...main, open_decision_count: 2 };
  const handlers = (role: "owner" | "member", seen: string[] = []) => [
    http.get(`${apiUrl}/organizations/:organizationId/projects`, () =>
      HttpResponse.json({ projects: [project({ role })] })
    ),
    http.get(`${apiUrl}/projects/:projectId/decisions`, ({ request }) => {
      const url = new URL(request.url);
      seen.push(url.searchParams.get("branch_id") ?? "all");
      return HttpResponse.json({ decisions: [decision(), claimed] });
    }),
    http.get(`${apiUrl}/projects/:projectId/merges`, () =>
      HttpResponse.json({
        runs: [
          run({
            source_branch_id: feature.id,
            target_branch_id: main.id,
            kind: "merge",
            trigger: "provider_merge",
            provider: {
              provider: "github",
              change_number: "42",
              change_url: "https://github.com/acme/app/pull/42",
              head_sha: null,
              merge_sha: null
            }
          })
        ],
        next_cursor: null
      })
    ),
    ...branchHandlers({ branches: [withDecisions, feature] })
  ];

  it("lists the branch's open decisions and settles one after a stale check", async () => {
    const seen: string[] = [];
    const choices: string[] = [];
    await render(`/projects/${projectId}/overview`, [
      http.post(
        `${apiUrl}/projects/:projectId/decisions/:decisionId/resolve`,
        async ({ request, params }) => {
          const { choice } = (await request.json()) as { choice: string };
          choices.push(`${params.decisionId}:${choice}`);
          if (params.decisionId === claimed.id)
            return HttpResponse.json(
              {
                error: {
                  code: "TASK_ALREADY_CLAIMED",
                  message: "The task is claimed on its branch.",
                  request_id: "req_2",
                  details: {}
                }
              },
              { status: 409 }
            );
          if (choices.length === 1)
            return HttpResponse.json(
              {
                error: {
                  code: "BRANCH_DECISION_STALE",
                  message: "The target changed.",
                  request_id: "req_1",
                  details: {
                    decision: decision({
                      target_values: { title: "Checkout wording" }
                    })
                  }
                }
              },
              { status: 409 }
            );
          return HttpResponse.json({
            decision: decision({ status: "resolved_target" })
          });
        }
      ),
      ...handlers("owner", seen)
    ]);
    const user = userEvent.setup();
    // Overview, the sidebar and the branch menu all point here.
    expect(await screen.findByText("Needs your decision")).toBeVisible();
    expect(screen.getByLabelText("2 open decisions")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Branch: main" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Needs your decision (2)" })
    );
    expect(await screen.findByText("DASH-7 Checkout copy")).toBeVisible();
    expect(seen).toEqual([main.id]);
    // Both decisions came from the same pull request.
    for (const link of screen.getAllByRole("link", { name: "PR #42" }))
      expect(link).toHaveAttribute(
        "href",
        "https://github.com/acme/app/pull/42"
      );
    await user.click(screen.getByRole("button", { name: "All branches" }));
    await waitFor(() => expect(seen).toEqual([main.id, "all"]));

    await user.click(
      screen.getByRole("button", { name: /DASH-7 Checkout copy/ })
    );
    const sheet = await screen.findByRole("dialog", {
      name: "DASH-7 Checkout copy"
    });
    expect(sheet).toHaveTextContent("Checkout copy");
    expect(sheet).toHaveTextContent("Checkout text");
    await user.click(
      within(sheet).getByRole("button", { name: "Use source (feat/checkout)" })
    );
    expect(
      await within(sheet).findByText(
        "The target changed since this merge. Review again."
      )
    ).toBeVisible();
    expect(sheet).toHaveTextContent("Checkout wording");
    await user.click(
      within(sheet).getByRole("button", { name: "Use target (main)" })
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "DASH-7 Checkout copy" })
      ).not.toBeInTheDocument()
    );
    expect(choices).toEqual([
      `${key(401)}:use_source`,
      `${key(401)}:use_target`
    ]);

    await user.click(
      screen.getByRole("button", { name: /DASH-8 Payment retries/ })
    );
    const claimedSheet = await screen.findByRole("dialog", {
      name: "DASH-8 Payment retries"
    });
    expect(claimedSheet).toHaveTextContent(
      "An agent is working on this task. You can choose once the claim ends."
    );
    await user.click(
      within(claimedSheet).getByRole("button", {
        name: "Use source (feat/checkout)"
      })
    );
    expect(await within(claimedSheet).findByRole("alert")).toHaveTextContent(
      "An agent is working on this task. You can choose once the claim ends."
    );
  });

  it("finds a decision's merge further back and keeps its link out of the row's button", async () => {
    const cursors: Array<string | null> = [];
    const merged = run({
      source_branch_id: feature.id,
      target_branch_id: main.id,
      kind: "merge",
      trigger: "provider_merge",
      provider: {
        provider: "github",
        change_number: "42",
        change_url: "https://github.com/acme/app/pull/42",
        head_sha: null,
        merge_sha: null
      }
    });
    await render(`/projects/${projectId}/decisions`, [
      // The decisions' merge is on the second page of history.
      http.get(`${apiUrl}/projects/:projectId/merges`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        cursors.push(cursor);
        return HttpResponse.json(
          cursor
            ? { runs: [merged], next_cursor: null }
            : { runs: [run({ id: key(302) })], next_cursor: "page-2" }
        );
      }),
      ...handlers("owner")
    ]);
    const links = await screen.findAllByRole("link", { name: "PR #42" });
    expect(cursors).toEqual([null, "page-2"]);
    const row = screen.getByRole("button", { name: /DASH-7 Checkout copy/ });
    expect(row).not.toHaveTextContent("PR #42");
    for (const link of links) expect(link.closest("button")).toBeNull();
    // Following the link leaves the sheet closed.
    const user = userEvent.setup();
    links[0]!.addEventListener("click", (event) => event.preventDefault());
    await user.click(links[0]!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(row);
    expect(
      await screen.findByRole("dialog", { name: "DASH-7 Checkout copy" })
    ).toBeVisible();
  });

  it("reads at most five pages of merge history looking for merges", async () => {
    const cursors: Array<string | null> = [];
    await render(`/projects/${projectId}/decisions`, [
      http.get(`${apiUrl}/projects/:projectId/merges`, ({ request }) => {
        cursors.push(new URL(request.url).searchParams.get("cursor"));
        return HttpResponse.json({
          runs: [run({ id: key(310 + cursors.length) })],
          next_cursor: `page-${cursors.length + 1}`
        });
      }),
      ...handlers("owner")
    ]);
    expect(await screen.findByText("DASH-7 Checkout copy")).toBeVisible();
    await waitFor(() => expect(cursors).toHaveLength(5));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cursors).toHaveLength(5);
    expect(
      screen.queryByRole("link", { name: "PR #42" })
    ).not.toBeInTheDocument();
  });

  it("says why nothing can be chosen instead of offering dead buttons", async () => {
    const onArchived = decision({
      id: key(406),
      label: "DASH-9 Old copy",
      target_branch_id: old.id
    });
    await render(`/projects/${projectId}/decisions`, [
      http.get(`${apiUrl}/projects/:projectId/branches`, () =>
        HttpResponse.json({ branches: [withDecisions, feature, old] })
      ),
      http.get(`${apiUrl}/projects/:projectId/decisions`, () =>
        HttpResponse.json({ decisions: [onArchived, decision()] })
      ),
      http.post(
        `${apiUrl}/projects/:projectId/decisions/:decisionId/resolve`,
        () =>
          HttpResponse.json(
            {
              error: {
                code: "CONFLICT",
                message: "This decision is already settled.",
                request_id: "req_3",
                details: {
                  reason: "decision_closed",
                  status: "resolved_source"
                }
              }
            },
            { status: 409 }
          )
      ),
      ...handlers("owner")
    ]);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: /DASH-9 Old copy/ })
    );
    const archivedSheet = await screen.findByRole("dialog", {
      name: "DASH-9 Old copy"
    });
    expect(archivedSheet).toHaveTextContent(
      "feat/old is archived, so nothing can change there."
    );
    expect(
      within(archivedSheet).queryByRole("button", { name: /Use / })
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "DASH-9 Old copy" })
      ).not.toBeInTheDocument()
    );

    await user.click(
      screen.getByRole("button", { name: /DASH-7 Checkout copy/ })
    );
    const sheet = await screen.findByRole("dialog", {
      name: "DASH-7 Checkout copy"
    });
    await user.click(
      within(sheet).getByRole("button", { name: "Use source (feat/checkout)" })
    );
    expect(
      await within(sheet).findByText("This decision is settled.")
    ).toBeVisible();
    expect(
      within(sheet).queryByRole("button", { name: /Use / })
    ).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lets members read decisions without choosing", async () => {
    await render(`/projects/${projectId}/decisions`, handlers("member"));
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: /DASH-7 Checkout copy/ })
    );
    const sheet = await screen.findByRole("dialog", {
      name: "DASH-7 Checkout copy"
    });
    expect(sheet).toHaveTextContent(
      "Only project owners and admins can choose."
    );
    expect(
      within(sheet).queryByRole("button", { name: /Use source/ })
    ).not.toBeInTheDocument();
  });
});
