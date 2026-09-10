# Private-alpha clean-Mac acceptance checklist

Status: **NOT RUN**. This checklist requires a disposable real hosted project,
one human owner, separate Codex and Claude Code credentials, and a clean Mac.
Do not replace those prerequisites with fixtures, mock IDs, or sample tokens.
Never record tokens, passwords, private keys, or Keychain values.

## Harness and evidence

Run the mechanics-only check first; it uses a temporary config root and must
not touch the real user configuration:

```sh
scripts/acceptance/clean-mac-acceptance.sh --self-check
```

For the real run, use an HTTPS API URL, the disposable project UUID, and an
evidence directory outside the repository. The harness validates macOS, Node
20+, `npx`, `codex`, `claude`, API health, the UUID, and private evidence
permissions. It snapshots the exact four Codex and Claude Code config paths
touched by setup/disconnect, captures only the health request ID, runs the
redacted `orchestrat doctor`, and compares hashes after disconnect:

```sh
scripts/acceptance/clean-mac-acceptance.sh --run \
  https://api.orchestrat.dev <real-project-uuid> \
  /private/tmp/orchestrat-acceptance-<timestamp>
```

The harness does not accept credentials, launch apps, or print/persist secrets.
Its interactive checkpoints require a human to complete setup and disconnect.

## Evidence already available from the local candidate

Keep this separate from the clean-Mac result below. Root lint, typecheck, and
tests pass: dashboard 274 unit tests, API 76 tests with 2 intentional opt-in
skips, and Rust 65 tests. Playwright passes 44 tests, including two actual R2
browser attachment workflows at both tested widths. The disposable PostgreSQL
plus actual R2 integration passes 10/10 subtests covering legacy author
preservation, idempotency, claims, expiry takeover, dependency gating,
same-base document conflicts, restartable backfill, a 100 MiB multipart upload,
concurrent completion, exact download bytes, single-use download tickets, and
cancellation. The installed local CLI alpha artifact also passes version and
real stdio MCP tool-list verification.

An unsigned Apple Silicon app and DMG were built with the actual public API,
Supabase, callback, and R2 origins. Only an earlier test build's sign-in screen
was observed. Hosted authentication, native R2, native notifications, final
artifact launch, clean-Mac setup, signing/notarization, and pilot use remain
**NOT RUN**.

## Evidence record

| Field                        | Value                 |
| ---------------------------- | --------------------- |
| Run status                   | NOT RUN / PASS / FAIL |
| Mac / macOS                  |                       |
| API origin                   |                       |
| Project UUID                 |                       |
| Evidence directory           |                       |
| Owner                        |                       |
| Start/end UTC                |                       |
| Health request ID            |                       |
| Other request IDs            |                       |
| Durable event sequence range |                       |
| Notes / blockers             |                       |

## Clean-Mac sequence

Record a timestamp, request IDs, event sequences, and PASS/FAIL for every row.

| #   | Scenario                                                                                                                                        | Timestamp | Request IDs / event sequences | Result  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------- | ------- |
| 1   | Install the DMG and launch Orchestrat; record unsigned/unnotarized trust warning if applicable.                                                 |           |                               | NOT RUN |
| 2   | Sign in through GitHub, then separately smoke-test magic link.                                                                                  |           |                               | NOT RUN |
| 3   | Create/select a project without configuring a Workspace.                                                                                        |           |                               | NOT RUN |
| 4   | Confirm CLI `0.1.0-alpha.1` or newer, then run setup; record preview and PATH guidance.                                                         |           |                               | NOT RUN |
| 5   | Preview/configure Codex and Claude Code separately.                                                                                             |           |                               | NOT RUN |
| 6   | Confirm separate agents and Keychain credential presence without recording values.                                                              |           |                               | NOT RUN |
| 7   | Create one ready task with no blockers, one blocked/dependency scenario, one Markdown document, and record the starting Activity/event cursor.  |           |                               | NOT RUN |
| 8   | Ask Codex and Claude Code to list and claim the ready task concurrently.                                                                        |           |                               | NOT RUN |
| 9   | Assert exactly one winner and a stable loser conflict.                                                                                          |           |                               | NOT RUN |
| 10  | Observe claim, agent, task, and Activity updates live.                                                                                          |           |                               | NOT RUN |
| 11  | Have the winner heartbeat, comment, and update the Markdown document.                                                                           |           |                               | NOT RUN |
| 12  | Trigger a stale document update; confirm `DOCUMENT_CONFLICT` and preservation of both contents.                                                 |           |                               | NOT RUN |
| 13  | Stop the winner, wait for lease expiry, and let the second agent claim.                                                                         |           |                               | NOT RUN |
| 14  | Complete the task; confirm only the useful native notification appears (no heartbeat/comment noise).                                            |           |                               | NOT RUN |
| 15  | Restart API/dashboard/CLI processes; verify durable realtime catch-up from the recorded cursor.                                                 |           |                               | NOT RUN |
| 16  | Run `orchestrat doctor`, then `orchestrat disconnect all`; save only redacted output and status.                                                |           |                               | NOT RUN |
| 17  | Confirm every snapshotted Codex/Claude config is byte-for-byte preserved or absent as before.                                                   |           |                               | NOT RUN |
| 18  | Create a task as each agent; verify truthful agent authors, metadata-only `expected_version` edits, human/agent comments, and idempotent retry. |           |                               | NOT RUN |
| 19  | Upload, render, download, and remove an attachment in the browser and native app; verify exact bytes, single-use download, and cancellation.    |           |                               | NOT RUN |
| 20  | Upgrade every tester to CLI `0.1.0-alpha.1` or newer before enabling agent-authored tasks; reject an older-client result as incompatible.       |           |                               | NOT RUN |

### Acceptance notes

- The real run is **NOT RUN** until a human fills the evidence fields above.
- Use a disposable hosted project with real backend state; do not call mutation
  APIs from this implementation task.
- Keep exactly one API replica for in-memory realtime tickets/connections.
- If an external gate is unavailable, mark that row BLOCKED/UNVERIFIED rather
  than inferring success.
