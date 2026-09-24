# Live MCP acceptance — 2026-09-21

Result: **PASS** at `2026-09-21T08:25:46Z`.

This run used the installed `/Users/armanghevondyan/.local/bin/orchestrat`
release artifact (`0.1.0-alpha.1`) twice: Codex and Claude Code MCP transports, both mapped to
the disposable project `8b236506-669d-46a3-a0c7-fe93a724321b` from
`/private/tmp/orchestrat-clean-config.cfUFCn`. It used hosted Orchestrat-dev
authentication with the local API/Postgres service at `http://localhost:8801`.
It is not a virgin-Mac test, a hosted-API test, or a fully hosted acceptance.
This validates the installed release artifact, not the current source checkout
or an unpublished rebuilt CLI.

## Evidence

- Two distinct live sessions and agent identities were opened and heartbeated:
  sessions `1374797f-db6f-4379-97fc-e850f487c209`,
  `c7cd4602-ace7-4e20-8d31-153cb1269027`; agents
  `c0249d0a-1964-466b-a49a-3c48c99afb2e`,
  `7ec729a3-55c5-4564-8822-f5a574e11771`.
- Created task `75beca40-656b-4a93-8bb1-8403010c2242` in `ready` state.
- Created idempotent comment `578d20e0-415d-4e85-b39c-24ca91082c10`; retry
  returned the same comment and its author was the Codex agent identity.
- Created document `1910fc58-700a-4ff5-b870-87c04d7535fb`, read it from the
  second transport, updated it, and verified stale revision `1` returned
  `DOCUMENT_CONFLICT` without overwriting the winner content.
- Concurrent claim race produced exactly one winner (Codex) and one
  `TASK_ALREADY_CLAIMED` loser (`409` semantics).
- The winner MCP child was killed. After the 30-second lease expired in
  five-second polling chunks, the loser took over and completed the task.
- A fresh MCP transport reconnected and verified the durable completed task,
  comment, winning document content, and 21 recent project events.
- A subsequent read-only MCP check verified the current durable event range
  `1097..1119` (`23` events returned).
- The reusable harness records each API conflict `request_id` without printing
  response bodies or credentials; the original run predates that logging and
  did not retain those two IDs.

## Reproduction

```sh
ORCHESTRAT_CLI=/Users/armanghevondyan/.local/bin/orchestrat \
ORCHESTRAT_ACCEPTANCE_CWD=/private/tmp/orchestrat-clean-config.cfUFCn \
ORCHESTRAT_ACCEPTANCE_PROJECT_ID=8b236506-669d-46a3-a0c7-fe93a724321b \
ORCHESTRAT_API_URL=http://localhost:8801 \
  node scripts/acceptance/mcp-live-acceptance.mjs
```

The harness validates the project UUID before mutations, inherits the real
`HOME`/`CODEX_HOME` for the existing disposable Keychain mapping, never prints
credentials or claim tokens, and terminates only its own MCP children.

## Follow-up verification — 2026-09-24 UTC

### Local dashboard and configuration cleanup

- The real local dashboard rendered the agent-created task and its Activity
  link opened the correct task detail. In the same disposable project, task
  `2a22629e-f7e6-41ed-a2ff-18e7f6313920` (`CLE-2`) rendered headings,
  checklist items, bold text, and inline code. Adding and removing a dependency
  on `CLE-1` succeeded, as did saving a human Markdown comment.
- Both temporary local agents were disconnected and their test-specific
  credentials removed after the MCP run. Existing unrelated identities were
  not deleted. The temporary local CLI authorization was retained.
- Original Orchestrat entries were restored in all five backed-up files:
  Codex config/hooks, Claude config/settings, and Orchestrat mappings. The four
  JSON files match the original hashes. The complete Codex MCP section matches
  the original, while newer unrelated Codex settings made during the pause
  were preserved. Private original and pre-restoration snapshots remain
  outside the repository. No credentials are included in this record.
- This was a reversible Orchestrat configuration reset on an existing Mac,
  not an erased machine or fresh macOS account.

### Hosted deployment boundary

- At `2026-09-24T02:59:47Z`, the restored public API returned `200` from
  `/health` (`req_4d831f83-4e6d-43f4-89ae-4c15ee80e7c6`) and `/ready`
  (`req_e74f112a-d757-4458-bbef-e49d9818f754`). Dashboard-origin CORS
  preflight returned `204` with the expected allowed origin.
- The user identified the deployment as PR #14 merge commit `471cef3`.
  Git ancestry confirms it contains API hardening commit `f3be8ee`; its
  `apps/api` and `packages/config` trees match this candidate. These health
  checks do not independently exercise hosted rate limits or shutdown.
- At `2026-09-24T03:01:17Z`, the public dashboard still served
  `assets/index-DJmpbZcD.js` containing alpha Supabase ref
  `smksrtwjwgwyfjhozamd`, not the requested dev ref
  `gyljsbasvnxpeowfonqp`. Its API origin was correct. Hosted acceptance remains
  **BLOCKED** until the frontend is rebuilt against the dev authentication
  project and fresh sign-in succeeds end to end.

### Candidate checks and remaining native gate

- Incremental commits cover API readiness/shutdown/rate limits (`f3be8ee`),
  actionable local setup (`1bb7159`), task Markdown/dependencies/Activity
  (`d739ce1`, `ab71967`, `b5b9cbe`), native notification destinations
  (`354addd`), and editor/mobile accessibility (`0210382`).
- Root lint, forced typecheck, and forced tests passed. The full test run
  required local IPC permission outside the sandbox. Dashboard: 301 passed;
  API: 77 passed, 2 opt-in skips; CLI: 74 passed. Native tests: 69 passed;
  Clippy and formatting passed. WebKit desktop/compact/phone coverage:
  66 passed, 4 opt-in storage skips.
- The initial documents route is 30.33 kB (9.72 kB gzip), versus the earlier
  1434.02 kB (474.33 kB gzip) baseline. Selecting a document still loads the
  deferred editor and shared CodeMirror chunks: 1345.38 kB total route/editor
  JavaScript (450.07 kB gzip). This is deferral, not removal of editor cost.
- An isolated debug app bundle built and launched through session restoration
  to the local dashboard. Actual Notification Center delivery, body/Open
  click-through, and a signed packaged release remain **UNVERIFIED**.
