# Project branches: local acceptance

Date: 2026-09-30 (UTC). Branch: `feat/project-branches`, rebased onto `main`
`a7cd310`, in the worktree `/Users/armanghevondyan/dev/orchestrat-branches`.

Status: **in progress, verified locally, not merged and not deployed.**

- The hosted database is not migrated to `0016`.
- The CLI is not published.
- Done so far: ORC-20 through ORC-28 (protocol, migration, API scoping, SDK, CLI and MCP) plus the ORC-43 rebase checkpoint.
- Still to come: the merge engine, providers and dashboard.

Spec: `docs/project-branches.md`. Provider setup:
`docs/project-branches-provider-setup.md`.

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

## What was checked

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

### Real-Postgres coverage for branches

**Migration and backfill.** `0016` moves every existing row in every scoped table onto one default branch, with IDs intact, and the rollout shim fills `branch_id` for the old API.

**Concurrency:**

- of four concurrent creations of the same branch name, exactly one wins and the rest get `BRANCH_NAME_TAKEN`;
- two agents registering the same checkout branch converge on one branch;
- claims on two branches are independent, and two sessions claiming one task get one winner;
- an archive racing a session open and a claim leaves no live session or claim on the archived branch;
- interleaved task writes on two branches keep one monotonic event cursor, and catch-up misses nothing.

**Attention long-poll against a branch-pinned session.** A DM on `main` does not wake a wait pinned to the feature branch; a DM on that branch does, and the summary reports that branch.

## Notes

- The first real-Postgres run right after restarting the local server failed during setup in all four real-Postgres test files. Every later run passed: three times for the branches file alone and twice for each full suite. It did not reproduce, and its cause was not found.
- The branches real-Postgres suite now drops its database without `FORCE`. `pool.end()` resolves before its sockets close, so a forced drop killed connections mid-close and surfaced as uncaught errors. A plain drop waits for them, as `postgres-acceptance` already does.

## NOT RUN

- Live providers (GitHub, GitLab.com, Cursor Origin): ORC-44, needs registered apps.
- Hosted rollout: ORC-45, needs Arman's approval at each step.
- R2 attachment acceptance (`ORCHESTRAT_TEST_R2=1`).
