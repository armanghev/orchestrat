# Agent attention and handoffs: local acceptance

Date: 2026-09-28 (UTC). Branch: `feat/agent-attention`, from `main` `e37bd65`,
in the worktree `/Users/armanghevondyan/dev/orchestrat-attention`.

Status: **implemented and locally verified. Not committed, not merged, not
deployed.** The hosted database has not been migrated to `0015`. The CLI has
not been published.

Spec: `docs/agent-attention-handoffs.md`. Plan:
`docs/agent-attention-implementation-plan.md`.

## What was checked

All commands ran from the worktree root. Real-Postgres suites used a local
`ORCHESTRAT_TEST_POSTGRES_URL` (the local dev-postgres admin database); every
suite creates and drops its own database.

| Check                                                      | Command                                                                                             | Result                                    | Baseline (`e37bd65`) |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------- |
| Build, lint, typecheck                                     | `pnpm turbo build lint typecheck --filter='!@orchestrat/landing'`                                   | 36/36 tasks passed                        |                      |
| API (pg-mem + real Postgres)                               | `pnpm turbo test --filter='!@orchestrat/landing' --filter='!@orchestrat/dashboard' --concurrency=1` | 147 pass, 0 fail, 2 existing opt-in skips | 98 pass              |
| MCP                                                        | same command                                                                                        | 35 pass                                   | 8                    |
| CLI                                                        | same command                                                                                        | 106 pass                                  | 74                   |
| SDK                                                        | same command                                                                                        | 16 pass                                   | 11                   |
| Protocol                                                   | same command                                                                                        | 18 pass                                   | 12                   |
| DB, including real-Postgres RLS and the migration backfill | same command                                                                                        | 17 pass                                   | 15                   |
| Dashboard unit tests                                       | `pnpm --filter @orchestrat/dashboard test`                                                          | 372 pass in 51 files                      | 337                  |
| Dashboard browser tests, WebKit with mocked API and axe    | `cd apps/dashboard && pnpm exec playwright test`                                                    | 78 passed, 6 skipped                      | 69 passed, 6 skipped |
| Two-agent simulation, real Postgres                        | `node scripts/acceptance/attention-simulation.mjs`                                                  | 6/6 passed in 9.4 s; database dropped     |                      |

The real-Postgres tests ran (they were not skipped):

- comment sequences and the completion guard under concurrency;
- agent status and blocker resolution under concurrency;
- the existing migration and concurrent agent/document workflow tests.

Simulation steps (spec §16):

1. **Completion guard.**
   - `complete_task` returns 409 `TASK_COMMENTS_UNREAD`, with the other
     agent's comment in the details.
   - The next tool response carries the `attention` notice.
   - A retry with `acknowledged_through` completes the task.
2. **Blocked, handoff, wait.**
   - Agent A is blocked on B and parks in `wait_for_update`.
   - B hands off to A; A's wait returns in about 0.4 s with `blocker_resolved`,
     `status_changed` and `handoff`.
   - The task moves to `in_progress`, and the block resolution is
     `participant_responded`.
3. **No updates.**
   - `no_updates` at the 5 s budget, with a cursor.
   - A later wait with that cursor catches the next watched comment.
4. **Stop hook** (Claude payload).
   - A pending handoff produces exit 2 with the fixed reason template; no
     message body is included.
   - `stop_hook_active` with no new items produces exit 0.
5. **Waker and chain limit.**
   - One handoff to an offline agent produces exactly one spawn, with a
     fixed-prompt argv, `shell: false`, one `run.woken` event and the owned
     session saved.
   - An agent-to-agent ping chain stops with 429 `HANDOFF_CHAIN_LIMIT` after
     hop 4.

## Rebase checkpoint (ORC-13)

- **Branches migration:** `feat/project-branches` has no commits beyond
  `e37bd65` and no `0014` migration yet. Checked read-only.
- **This branch's migration:** `0015`'s journal `when` is `1790600000000`,
  which is greater than `0013`'s `1790244000000`.
- **Ordering rule:** whichever feature merges second must give its migration a
  larger `when` than the first. The drizzle migrator skips migrations with a
  smaller one (spec §5).
- **Still to run:** the checkpoint again once branches has a `0014`, or before
  the final merge.

## NOT RUN (explicit boundaries)

- **Real harness smokes:** `claude -p --resume`, `codex exec resume`, `agent
--resume -p`, `agy --conversation` and `opencode run --session`. The waker's
  flag spellings are marked TODO-verify in `apps/cli/src/waker.ts`.
- **Claude Code `asyncRewake`** waking an idle Desktop, terminal or IDE session.
- **Harness stop continuation for real:**
  - the Codex `Stop` block;
  - the Cursor `followup_message` (IDE and `agent -p`);
  - the Antigravity `Stop` continue;
  - the OpenCode idle plugin.

  Only recorded payload fixtures were tested.

- **The CLI stop command end to end.** It always reads the macOS Keychain, so
  the simulation called `decideStop`/`renderStopDecision` with an in-memory
  credential reader.
- **Real MCP clients over stdio:** client tool timeouts and whether progress
  notifications reset them. The simulation used the in-memory transport.
- **`orchestrat waker enable`** interactive confirmation, which needs a TTY.
- **Real harnesses and the hosted system:** hosted two-agent acceptance,
  migrating the hosted database to `0015`, deploying the API or dashboard, and
  publishing the CLI.
- **The Claude `SessionStart` attention digest** (optional in spec §11.3) is
  not implemented.
