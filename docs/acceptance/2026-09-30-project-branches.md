# Project branches: local acceptance

Date: 2026-09-30 (local time). Branch: `feat/project-branches`, rebased onto `main`
`a7cd310`, in the worktree `/Users/armanghevondyan/dev/orchestrat-branches`.

Status: **implemented and verified locally, not merged and not deployed.**

- The hosted database is not migrated to `0016`.
- The CLI is not published.
- Done: ORC-20 through ORC-42, the ORC-43 rebase checkpoint, and the fixes from the wrap-up review.
- Not started: live providers (ORC-44), the hosted rollout (ORC-45) and the cleanup migration (ORC-46).

Spec: `docs/project-branches.md`. Provider setup:
`docs/project-branches-provider-setup.md`. API reference: `docs/api/README.md#branches`.

## Full feature (ORC-20 to ORC-42)

Each task landed as one commit, marked `(ORC-NN)` in its message body (`git log --oneline a7cd310..HEAD`). The spec itself is `a2d1b72`.

| Task   | Commit      | What landed                                                                                                                        |
| ------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| ORC-20 | `f6db558`   | Protocol contracts for branches, merges and repositories                                                                           |
| ORC-21 | `9ea3e53`   | Migration `0016`, schema and backfill                                                                                              |
| ORC-22 | `5331656`   | Branch core, resolution rules and branch events                                                                                    |
| ORC-23 | `7e200d2`   | Tasks, claims, sessions, hooks, presence and events scoped to branches                                                             |
| ORC-24 | `bb9774d`   | Documents, attachments and chats scoped to branches                                                                                |
| ORC-25 | `6c5aedc`   | Branch isolation and concurrency suite                                                                                             |
| ORC-26 | `8120674`   | SDK branch headers, session pins and the branches API                                                                              |
| ORC-27 | `e684652`   | CLI checkout detection, `orchestrat branch` and branch-aware hooks                                                                 |
| ORC-28 | `7c551b5`   | MCP `list_branches`, `select_branch` and checkout following                                                                        |
| ORC-43 | `82e4ac5`   | Rebase checkpoint with agent attention (below)                                                                                     |
| ORC-29 | `782be9a`   | Merge engine core: tasks, comments and dependencies                                                                                |
| ORC-30 | `7b39f19`   | Merge engine: documents, attachments, folders and chats                                                                            |
| ORC-31 | `1329255`   | Import, merge and decision endpoints                                                                                               |
| ORC-32 | `d767944`   | Repository core: webhook inbox, sync worker and branch sync                                                                        |
| ORC-36 | `bb4d4d9`   | Merged pull requests merge their branches                                                                                          |
| ORC-33 | `26dbc4a`   | GitHub App adapter                                                                                                                 |
| ORC-34 | `7153378`   | GitLab.com adapter                                                                                                                 |
| ORC-35 | `0b2d586`   | Cursor Origin adapter                                                                                                              |
| ORC-37 | `b85dda2`   | Dashboard branch context, breadcrumb selector and page scoping                                                                     |
| ORC-38 | `f3519e9`   | Dashboard branch management and manual merge                                                                                       |
| ORC-39 | `ad55643`   | Dashboard onboarding, imports and Decisions                                                                                        |
| ORC-40 | `96c3296`   | Dashboard repository settings, and `POST /projects/:projectId/repository/hook/reenable`                                            |
| ORC-41 | `8f76d65`   | Playwright branches spec with axe checks, `apps/dashboard/e2e/branches.spec.ts`                                                    |
| Review | `f243fd9`   | API gaps found while documenting: registration limit, status events, preview rules, fork runs, archive reason, GitHub install flow |
| Review | `eba004f`   | Dashboard fixes from the code review (below)                                                                                       |
| ORC-42 | this commit | API, architecture, agent setup, product and design docs, and this record                                                           |

### What was checked

Commands ran from the worktree root. Real-Postgres suites use a local scratch PostgreSQL through `ORCHESTRAT_TEST_POSTGRES_URL`, and every suite creates and drops its own database.

| Check                                             | Command                                          | Result                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| API unit and pg-mem tests                         | `pnpm --filter @orchestrat/api test`             | 220 tests: 215 pass, 0 fail, 5 opt-in skips (the real-Postgres files without their environment variables) |
| API real Postgres                                 | `pnpm --filter @orchestrat/api test:postgres`    | 32 tests: 31 pass, 0 fail, 1 skip (the R2 subtest without `ORCHESTRAT_TEST_R2=1`)                         |
| DB on real Postgres                               | `pnpm --filter @orchestrat/db test` with the URL | 19 tests pass                                                                                             |
| Dashboard unit tests                              | `pnpm --filter @orchestrat/dashboard test`       | 430 tests passed in 57 files                                                                              |
| Dashboard browser tests (WebKit, mocked API, axe) | `cd apps/dashboard && pnpm exec playwright test` | 103 passed, 6 skipped (the R2 document specs)                                                             |
| Build, lint and typecheck                         | `pnpm build && pnpm lint && pnpm typecheck`      | Pass                                                                                                      |
| Every package's tests                             | `pnpm test`                                      | Pass: CLI 116, MCP 46, SDK 21, protocol 26, DB 19 (2 opt-in skips), auth 17, config 7, landing 2          |

The branches spec (`apps/dashboard/e2e/branches.spec.ts`, ORC-41) adds 25 runs across the desktop, compact and phone projects. Its import and decision tests passed with `--repeat-each=3` (30 and 9 runs) before the review fixes; after them the whole suite passed once.

### Review fixes

A docs pass and a code review of the dashboard lane found these, all fixed with tests:

- API (`f243fd9`): branch registration is now limited per agent credential; connection status changes emit `repository.status_changed`; previews follow the apply's permission and archived-target rules; fork merges record a skipped run; archiving closes sessions with reason `branch_archived`; GitHub's picker gets `install_url` and the Setup URL finds its attempt on the server.
- Dashboard (`eba004f`): the import dialog re-checks conflict choices whenever its preview refreshes, not only after a 409; a page without `?branch=` keeps its branch when the default moves; the Decisions row no longer nests its PR link in a button; settled decisions and archived targets show a line instead of dead buttons; the reconnect summary covers every branch; mention notices keep the branch; a failed disconnect shows in its dialog; a branch switch waits for an autosave in flight.

### What the suites cover

**API, pg-mem** (`apps/api/src/routes/{branches,branch-scoping,branch-content,merges,provider-merges,repository}.test.ts` and `apps/api/src/services/{merge-engine,merge-content,github-adapter,gitlab-adapter,origin-adapter}.test.ts`):

- Legacy requests land on the default branch. The resolution rules hold for the query, the headers, session pins and entity rows. Malformed branch headers are refused before any work.
- Isolation: task keys, document paths and direct messages are unique per branch; cross-branch dependencies, blocks, handoffs and message document references are refused; idempotency keys are per branch with the legacy replay on the default.
- The permission matrix, archive (sessions closed, claims revoked), set default, onboarding, and registration that never revives a provider-deleted branch.
- Engine rules: copy, apply, keep and conflict; add/add by path; path collisions; claimed targets; status columns; comments; the dependency closure and cycle skips; attachment references; chat audiences, direct messages and unread history; stacked baselines; stale previews, key replays and provider dedupe; size bounds.
- Decisions: `use_target` remembers, `use_source` applies (documents from the recorded revision), a moved target refreshes or settles, and a claimed task waits.
- Repository connect and branch sync against a fake provider: link and snapshot on connect, pushes, confirmed deletes, generations, stale deletes, default moves and renames, suspension and revocation, webhook signatures and dedupe, backoff, and secrets bound to row and purpose with key rotation.
- Provider merges: delete-before-merge, a merge found only by reconcile, forks and unknown heads, and stacked branches.
- Adapters against `FakeGitHub`, `FakeGitLab` and `FakeOrigin` (`apps/api/src/services/repository/testing/`), with GitHub's documented signature test vector, generated Standard Webhooks keys and a test Ed25519 JWKS.

**API, real Postgres** (`apps/api/src/operations/branches-postgres.integration.test.ts`, 14 subtests). The checkpoint's six (below) plus eight from the engine and provider lanes:

- a failing apply leaves nothing behind;
- concurrent applies with one idempotency key make one run;
- an apply racing a target edit never loses an update;
- a failed apply deletes the attachment objects it copied;
- concurrent duplicate deliveries are stored once;
- a crashed worker's delivery is reset and applied once;
- a failed delivery backs off, then applies;
- concurrent GitLab token users refresh once and share the new token.

**Dashboard, vitest** (`apps/dashboard/src/routes/{branches,branch-imports,repository-settings}.test.tsx` and the branch, repository, realtime and command unit tests): breadcrumb switching and `?branch=` retention, Branch unavailable, per-page branch requests, read-only archived pages, deep links to another branch, draft safety on switch, member and owner settings, merge with a stale preview, onboarding, locked required tasks and required conflict choices, stale-preview carry-over, Decisions for owners and members, and the repository wizard and settings.

### Deviations from the spec

Code structure:

- `branch-context.ts` and `branch-service.ts` are flat files in `apps/api/src/services/`, not a `services/branches/` folder.
- Reconcile lives in `repository/branch-sync.ts` and `repository/sync-worker.ts` (there is no `reconcile.ts`), provider merges in `repository/provider-merges.ts`, and the webhook routes in `routes/repository.ts` (there is no `routes/webhooks.ts`). The CLI's branch command and overrides share `apps/cli/src/branches.ts`.
- The default branch is repaired lazily on read (`defaultBranch()` in `branch-context.ts`), not at boot.

Agent and SDK surface:

- Presence is project-wide. Each entry carries `branch_id` and the dashboard compares it; there is no `other_branch_id`, and presence takes no `branch_id` query.
- Inbox items carry `branch_id` only on all-branch reads.
- Human attention spans all branches.
- `GET /agent/project` has no `branch` field; it adds only `default_branch_id`. The MCP's `get_project` adds `branch` itself.
- SDK branch methods (`client.branches.list`, `get` and `register`) take snake_case protocol inputs, and the SDK takes a `sessionId` option with `withSession()` instead of a `sessionHeader` option.
- Human entity routes (`/tasks/:id…`, `/documents/:id…`, `/chats/:id…`) don't read `?branch_id=`. They take the branch from the row, so a different `branch_id` is ignored rather than answered with `404`.
- The registration limit (10 per minute per agent credential, spec §12) counts only registrations that create a branch; re-registering an existing branch is free, because the CLI does it on every session start. A limited request gets `429 RATE_LIMITED` with `Retry-After`, and the CLI then works on the default branch, as it does for any registration error.

Merge engine:

- Merge runs reuse `api_idempotency_keys` with operation `branch_apply`. `branch_merge_runs` has no `idempotency_key` or `request_hash` columns.
- Skipped provider runs point the source at the target, because they have no source branch to name.
- The engine reads inline revision content (`content_markdown`), not the R2 copy, and writes copied revisions inline.
- The `source_empty` skip reason and the `failed` run status are never written: a failed apply rolls back and leaves no run.

Providers:

- GitHub calls use `/repositories/{id}` paths. Not yet verified live.
- The Origin `getBranch` endpoint and the Origin app JWT `kid` (the app ID) are unverified.
- When GitHub needs a fresh authorization, `POST …/github-installation` returns `409 REPOSITORY_AUTHORIZATION_INVALID` instead of `{ next: "authorize", authorize_url }`. The dashboard handles the `authorize` answer, but only against mocks.
- ORC-40 added `POST /projects/:projectId/repository/hook/reenable`: owner or admin, `202 { queued: true }`. GitLab sends a test delivery; other providers get `409 CONFLICT` with `reason: "no_hook"`.
- Added after review: GitHub candidates carry `install_url`, so the picker offers **Install the GitHub App** when a repository isn't listed. `GET /repository/authorizations/pending?provider=github` returns the person's newest authorized attempt, so the Setup URL works in a browser that didn't start the flow, including after the desktop app hands off to the system browser.
- The API has no in-place reauthorization, so the dashboard's **Reconnect** disconnects and authorizes again. Branches and work are kept.

Dashboard:

- The import dialog's **Compare** shows field values side by side, not the revision compare view.
- It shows no per-document attachment counts, because the preview doesn't include them.
- Task statuses come from the source branch's task list.
- It has one search field above the tabs, not one per tab.
- The "also create branches" option shows no N, because the candidates list has no branch counts.
- Overview has no separate onboarding card, because the onboarding panel shows above every page, Overview included.
- "Needs your decision (N)" uses the current branch's open count.
- Search (⌘K) offers active branches only.
- Archived rows in Branch settings have no actions. Their work moves through the archived banner's **Import into another branch**.

## Rebase checkpoint with agent attention (ORC-43)

Attention merged first with migration `0015`, so branches use `0016`.

The rebase onto `a7cd310` brought in six commits:

- the handoff fix `aa3a4db`;
- the OpenCode removal;
- CLI fixes.

Two conflicts were resolved by hand:

- **`apps/cli/src/main.ts`:** the usage string. It keeps main's text without OpenCode and adds the `branch` command.
- **`scripts/acceptance/verify-cli-alpha.sh`:** the bundled tool list and the `tools/list` expectation keep the attention tools and add `list_branches` and `select_branch`.

`0016` still sorts after `0015` by journal `when`. A schema test guards this, because the drizzle migrator silently skips a migration whose `when` is at or below the newest one applied.

### What was checked

Commands ran from the worktree root. The real-Postgres suites used a local scratch PostgreSQL 17 on `127.0.0.1:55448` through `ORCHESTRAT_TEST_POSTGRES_URL`. Every suite creates and drops its own database.

| Check                                                         | Command                                            | Result                                 |
| ------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| Build                                                         | `pnpm build`                                       | 13/13 tasks                            |
| Lint                                                          | `pnpm lint`                                        | 13/13 tasks                            |
| Typecheck                                                     | `pnpm typecheck`                                   | 21/21 tasks                            |
| Unit and pg-mem tests                                         | `pnpm test`                                        | 26/26 tasks (details below)            |
| API real Postgres                                             | `pnpm --filter @orchestrat/api test:postgres`      | 23 pass, 0 fail, 1 opt-in R2 skip      |
| DB, including real-Postgres RLS and backfills                 | `pnpm --filter @orchestrat/db test`                | 19 pass                                |
| Dashboard browser tests (WebKit, mocked API, axe)             | `cd apps/dashboard && pnpm exec playwright test`   | 78 passed, 6 skipped                   |
| Two-agent attention simulation (real Postgres, 16 migrations) | `node scripts/acceptance/attention-simulation.mjs` | 6/6 passed in 24.1 s; database dropped |

`pnpm test` per package:

| Package   | Result                                                                                      |
| --------- | ------------------------------------------------------------------------------------------- |
| API       | 155 pass, 0 fail, 5 opt-in skips (real Postgres and R2 without their environment variables) |
| CLI       | 116 pass                                                                                    |
| MCP       | 46 pass                                                                                     |
| Protocol  | 26 pass                                                                                     |
| SDK       | 21 pass                                                                                     |
| Dashboard | 51 files pass                                                                               |

#### Real-Postgres coverage for branches

**Migration and backfill.** `0016` moves every existing row in every scoped table onto one default branch, with IDs intact, and the rollout shim fills `branch_id` for the old API.

**Concurrency:**

- of four concurrent creations of the same branch name, exactly one wins and the rest get `BRANCH_NAME_TAKEN`;
- two agents registering the same checkout branch converge on one branch;
- claims on two branches are independent, and two sessions claiming one task get one winner;
- an archive racing a session open and a claim leaves no live session or claim on the archived branch;
- interleaved task writes on two branches keep one monotonic event cursor, and catch-up misses nothing.

**Attention long-poll against a branch-pinned session.** A DM on `main` does not wake a wait pinned to the feature branch; a DM on that branch does, and the summary reports that branch.

### Notes

- The first real-Postgres run right after restarting the local server failed during setup in all four real-Postgres test files. Every later run passed: three times for the branches file alone and twice for each full suite. It did not reproduce, and its cause was not found.
- The branches real-Postgres suite now drops its database without `FORCE`. `pool.end()` resolves before its sockets close, so a forced drop killed connections mid-close and surfaced as uncaught errors. A plain drop waits for them, as `postgres-acceptance` already does.

## Live providers (ORC-44), 2026-10-05

Arman tested by hand against the local API (`orchestrat_branches` on Postgres 17), the local dashboard, and real GitHub and GitLab.com apps, through a Cloudflare quick tunnel. ngrok was blocked by the home network's security filter (Spectrum Security Shield), which redirects ngrok domains. Checklist: `docs/project-branches-manual-test.md`.

| Check                                                                                               | Result                                                                                                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub: connect, installing the app from the picker's **Install the GitHub App**                    | PASS, after fixing branch reads (below)                                                                                                          |
| GitHub: push a new branch → Orchestrat branch                                                       | PASS (`create` and `push` deliveries applied)                                                                                                    |
| GitHub: disconnect keeps branches and work                                                          | PASS                                                                                                                                             |
| GitLab.com: connect with OAuth; Orchestrat creates its project webhook                              | PASS                                                                                                                                             |
| GitLab.com: push a new branch → Orchestrat branch                                                   | PASS (`Push Hook` applied)                                                                                                                       |
| GitLab.com: merge request merged with "Delete source branch"                                        | PASS: a `provider_merge` run; the task copied to `main`; `notes.md` (added on both) became a decision; `feat/two` archived as `provider_deleted` |
| Task conflicts from a dashboard-triggered merge (`changed_on_both` on title, description, priority) | PASS: two task decisions, shown side by side                                                                                                     |
| Resolving decisions in the dashboard                                                                | PASS for **Use target** (3 decisions); **Use source** was not tried live                                                                         |

Bugs found and fixed:

- `aa5b146`: GitHub refused to list or read branches with Metadata-only installation tokens (HTTP 403). Branch reads now mint a Contents:read token. And one redelivery GitHub refused (HTTP 404, the app's first ping) failed the whole reconcile and marked the connection **Error**; refusals are now logged and skipped.
- `8ffb00d`: document decisions showed "—" on both sides, because they store revision ids, not text. Decisions now carry both versions' `body`.
- `bc11f67`: Cursor Origin is hidden behind `ORCHESTRAT_ORIGIN_ENABLED` (off) until its API leaves beta.

Not run live: a merged GitHub pull request, deleting a branch with `git push --delete`, catching up after downtime (reconcile), a paused GitLab webhook and **Re-enable**, revoked GitLab access and **Reconnect**, a suspended GitHub installation, **Use source** on a decision, agents following the checkout, and Cursor Origin.

## NOT RUN

- **The rest of the live provider checks** listed under "Not run live" above, and **Cursor Origin** entirely (hidden until its API leaves beta).
- **Hosted migration and rollout**: ORC-45. The hosted database is not migrated to `0016`, nothing is deployed, and the CLI is not published. Each step needs Arman's approval (spec §16).
- **The cleanup migration** that drops the rollout trigger: ORC-46, after the rollout.
- **A VoiceOver screen-reader pass** on the branch selector, the import dialog and the decisions sheet.
- **R2 document-storage specs.** They skip without R2 credentials (`ORCHESTRAT_TEST_R2=1`). The server-side attachment copy that imports and merges make has run only against an in-memory store.
- **The Tauri `cargo test`** for the optional notification `branchId`. Its cold build ran out of disk; `rustfmt --check` passes.
