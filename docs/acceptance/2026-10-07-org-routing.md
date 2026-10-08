# Organization routing and creation flows: local acceptance

Date: 2026-10-07 (local time). Branch: `feat/org-routing`, cut from `main` `0a9aeca`. `main` was merged in at `400bb3c` (merge commit `0eca3aa`). Integration worktree: `/Users/armanghevondyan/dev/orchestrat-org-50`.

Status: **implemented and verified locally, not pushed, no PR.** No database migration.

Plan: Orchestrat document `plans/org-routing-and-creation.md`. Tasks ORC-47 (coordination) to ORC-56 in project `d96abcc8`. The work was split between Claude, Codex and Cursor, with Claude merging.

## What changed

- **Org pages.**
  - Organizations have a home at `/organizations/$organizationId`: a project grid with search, sort and an archived filter.
  - A new org shell has a Projects / Members / Settings sidebar. Members and Settings are separate pages inside it.
- **Creation pages.** Organizations and projects are created on full pages:
  - `/organizations/new`: the slug is derived from the name and editable; a taken slug is reported on the field.
  - `/organizations/$organizationId/projects/new`: name, task key, description, and a Git source.
- **Repo connect at creation.** Choosing a provider creates the project, then sends the person to the provider with `/projects/$projectId/connect` as the return path. That page picks the repository and the default-branch mapping.
- **Landing.** `/setup` only decides where a signed-in person lands: the most recent accessible project, else the first organization's home, else `/organizations/new`.
- **Bug fix.** "New project" no longer defaults to the alphabetically first organization.
- **Toolbar.** The organization name opens its home; a chevron opens the organization switcher.

| Task   | Owner  | Commit    | What landed                                                                                            |
| ------ | ------ | --------- | ------------------------------------------------------------------------------------------------------ |
| ORC-48 | Codex  | `6acfd21` | `GET /organizations/:id/project-summaries` (protocol, SDK, dashboard client)                           |
| ORC-54 | Cursor | `f2a8a93` | `/projects/$projectId/connect`; wizard steps extracted from the settings dialog                        |
| ORC-50 | Claude | `b86a7d2` | Shell split (`ShellFrame`, `AppShell`, `OrganizationShell`), org routes, landing resolver, toolbar, ⌘K |
| ORC-49 | Codex  | `94873d6` | `GET /repository/providers`; GitHub install and pending responses return `return_path`                 |
| ORC-55 | Claude | `7f75da5` | Create-project page with Git source picker                                                             |
| ORC-53 | Codex  | `8d1249d` | Create-organization page, `slugifyName` in protocol, `409 ORGANIZATION_SLUG_TAKEN`                     |
| ORC-51 | Cursor | `f7e6e16` | Org home project grid; per-organization view preference                                                |
| —      | Claude | `defef48` | Theme-provider fixture for the new preference                                                          |
| ORC-52 | Claude | `cad4d98` | Members table, slimmer settings; layout keeps focus on a page-focused field (fixed a flaky test)       |
| ORC-56 | Claude | `95a4732` | DESIGN.md (shell, org home, creation pages); removed the old creation form                             |
| ORC-56 | Claude | `b0dd961` | Fixes from the review subagent (below)                                                                 |

### Review fixes (`b0dd961`)

A subagent reviewed the full diff (`main...feat/org-routing`) and found no high-severity issues. It confirmed:

- the summaries SQL returns only the caller's projects;
- `return_path` stays same-origin;
- no redirect loops.

Its six lower findings were all fixed:

1. **Members page.** Your own row is read-only. Role changes and removals refresh the catalog and org home, not only the members list.
2. **Repository changes.** Connecting or disconnecting a repository marks the org home stale.
3. **Slug helper.** `slugifyName` no longer calls `crypto.randomUUID` directly, which is missing on dashboards served over plain http. The new-organization form leaves the slug empty for names with no letters or digits.
4. **Leaving or deleting an organization.** The org's cached queries are dropped before `/setup` decides, so there's no "Organization unavailable" flash.
5. **Slugs without a chosen value.** Organizations created without a slug (CLI, SDK, MCP) get a random suffix when the derived slug is taken. A chosen slug still returns `ORGANIZATION_SLUG_TAKEN`.
6. **Summaries query.** The aggregates are limited to the caller's projects.

## Verification

All counts are from the final tree (`b0dd961`) unless noted.

| Gate                                                                     | Result                                                                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `act push -j verify` (lint, typecheck, test, build; Postgres 17 service) | **Job succeeded.** API 265 passed, 2 skipped; dashboard Vitest 474 passed; other packages all passing                  |
| `act push -j browser` (Playwright, WebKit)                               | **Job succeeded.** 111 passed, 6 skipped                                                                               |
| Real Postgres                                                            | Ran inside the verify job against `postgres:17`, including "project summaries enforce membership and aggregate counts" |
| Local Playwright (`CI=1`, macOS)                                         | 109 passed, 6 skipped before the review fixes. CI's browser job above is the final run                                 |
| Screenshots                                                              | Org home (light and dark), Members, Settings, New project (empty and filled), New organization: checked by eye         |

New tests:

- **Dashboard:**
  - `routes/create-project.test.tsx`
  - `routes/create-organization.test.tsx`
  - `features/hierarchy/organization-home-page.test.tsx`
  - `features/settings/organization-members-page.test.tsx`
  - `routes/connect-page.test.tsx`
  - landing and org-route cases in `routes/routes.test.tsx`
  - org-mode commands in `features/command/commands.test.ts`
- **API:**
  - project summaries (pg-mem and real Postgres)
  - `/repository/providers` and `return_path` in `routes/repository.test.ts`
  - `routes/organization-creation.test.ts`, including the derived-slug suffix
- **Playwright:**
  - org home → members → settings with axe
  - create-project → provider → connect, on all three Playwright projects
  - an updated create-organization flow

The two API skips predate this work and skip on `main` too:

- "real PostgreSQL serializes two same-base document writes";
- the R2 attachment round trip.

## NOT RUN

- **Live GitHub/GitLab/Origin.** The provider flows ran only against mocks. Production providers are still unconfigured, so the Source rows will show "isn't set up on this server" in prod until `ORCHESTRAT_GITHUB_APP_*` / `ORCHESTRAT_GITLAB_OAUTH_*` and related env vars are set.
- **Desktop.** The Tauri desktop app was not run (no cargo build). The desktop provider path (`openExternal`, then land on repository settings) is covered by code review only.
- **Hosted environments.** No deployment, and no hosted database change (none is needed: no migration).

## Known gaps and follow-ups

- **Provider logos.** Rows and cards show a generic Git icon and the provider name. The dashboard has no GitHub/GitLab brand marks yet.
- **Org invites.** Invites stay per project; Members says so.
- **Repo-first creation.** Pick a repository first and get its name prefilled (Vercel-style). This needs org-scoped repository authorizations. Agreed as a later follow-up.
