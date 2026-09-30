# Local agent setup (private alpha)

This guide covers the current macOS/private-alpha path for connecting supported
coding agents to one Orchestrat project. It is for trusted testers running from
the intended project directory. The CLI requires Node.js 20.19+ on the 20.x line
or Node.js 22.12+ and installs a
self-contained managed runtime under `~/.orchestrat/runtimes` with a stable
`~/.local/bin/orchestrat` launcher. Use the
[private-alpha runbook](private-alpha-runbook.md) for verified release
status, deployment operations, and the clean-Mac acceptance boundary.

## Prerequisites

- macOS and Node.js 20.19+ (or 22.12+).
- An authorized published `@orchestrat/cli` package for trusted-tester setup.
  The source-build command in the [private-alpha runbook](private-alpha-runbook.md)
  is validation only, not clean-Mac installation evidence.
- An Orchestrat account and access to the target project.
- `ORCHESTRAT_API_URL` may override the API; the default is
  `https://api.orchestrat.dev`.
- Use only the browser authorization flow and API endpoint intended for trusted
  private-alpha testing. Do not paste credentials into config files or logs.

Run setup from the project directory whose mapping should be used:

```bash
orchestrat setup
```

The `0.1.0-alpha.2` release is published under both `alpha` and `latest`;
see the [release acceptance record](acceptance/2026-09-24-cli-alpha2-release.md).
Install or upgrade with
`npx --yes @orchestrat/cli@0.1.0-alpha.2 setup`, then check `orchestrat --version`
and restart agent MCP connections. Running an older persistent launcher does
not automatically fetch the newest npm package. The `latest` tag advances only
after hosted acceptance; use the exact version during staged release testing.

Setup detects installed Claude Code, Codex, Cursor, Antigravity, and Pi
commands, then asks which configurable agents to connect. Before any
mutation it prints the paths and managed entries that will change. Browser
authorization proves the account only; the CLI then asks for the project to
configure. It creates a separate project-scoped agent identity and credential
per selected integration, and stores those credentials in separate macOS
Keychain entries. The persistent launcher is `~/.local/bin/orchestrat`; the
local project and agent mapping is non-secret metadata.

CLI and agent credentials are bound to the API origin that issued them. After
updating from a version with unbound credentials, run `orchestrat setup` again
for each intended API and reconnect the selected agents. Legacy entries are
ignored rather than assigned an issuer from editable configuration. Changing
`ORCHESTRAT_API_URL` never reuses another server's credentials. `disconnect
--local` remains available for offline cleanup.

Claude Code, Codex, Cursor, and Antigravity receive MCP and lifecycle-hook
configuration.

Pi is detected and reported, but is not selectable because it has no stable
built-in MCP configuration path.

Managed files are:

- `~/.orchestrat/config.json`
- `~/.codex/config.toml`
- `~/.codex/hooks.json`
- `~/.claude.json`
- `~/.claude/settings.json`
- `<project>/.cursor/mcp.json` or `~/.cursor/mcp.json` (chosen during setup;
  global setup asks which projects each selected harness may access, then the
  harness calls `select_project` before project-scoped work)
- `~/.cursor/hooks.json`
- `~/.gemini/config/mcp_config.json`
- `~/.gemini/config/hooks.json`

Each changed file may have a sibling `.orchestrat-backup`. Credentials never
belong in the JSON/TOML config or mapping.

## Daily commands

For personal use from this checkout, `pnpm cli:install` builds and replaces the
managed CLI runtime while preserving project mappings and Keychain credentials.
Restart agent MCP connections after an update so they load the new tool list.
Use `pnpm dev:api` (port `8801`) and `pnpm dev:dashboard` (port `8813`) for the
local services. New local setup uses:

```bash
ORCHESTRAT_API_URL=http://localhost:8801 ORCHESTRAT_WEB_URL=http://localhost:8813 orchestrat setup
```

Existing project connections use the API origins saved in
`~/.orchestrat/config.json`; changing an API port also requires updating those
saved local origins.

```bash
orchestrat setup
orchestrat status
orchestrat doctor
orchestrat disconnect codex
orchestrat disconnect claude-code
orchestrat disconnect cursor
orchestrat disconnect antigravity
orchestrat disconnect all
```

`hook` and `mcp` are managed integration commands installed by setup; they are
not ordinary manual workflows. Hooks report only low-volume normalized
`session.started`, `session.ended`, and `run.failed` lifecycle events. Session
end and failure never complete or assign a task.

## Attention, waiting and handoffs

Orchestrat tells agents about work addressed to them. After each Orchestrat MCP
tool call, the response can carry two notices: the existing `unread_chats`
notice and an `attention` notice. The `attention` notice lists unread comments
and mentions on watched tasks, pending handoffs, and resolved blockers.

- **Watching.** Agents automatically watch tasks they create, claim, comment on,
  are mentioned on, or receive a handoff for. `watch_task` with
  `watching: false` mutes a task; mentions still come through.
- **Reading.** Reading comments doesn't mark them read. Call
  `acknowledge_attention` after reading. Posting a comment does not count as
  reading.
- **Completing safely.** `complete_task`, `release_task` and
  `set_task_status(review)` refuse with `TASK_COMMENTS_UNREAD` while comments
  posted since the claim are unacknowledged. The error lists those comments.
  Read them, then retry with `acknowledged_through` set to the latest
  sequence.
- **Status.** `set_task_status` reports `in_progress`, `blocked` (a reason is
  required; `blocked_on` or `blocking_task_id` are optional) or `review`.
  - `review` ends the claim.
  - A blocked task stays blocked even if the session ends.
  - The block resolves automatically when the blocking task finishes, or when
    the `blocked_on` participant comments or hands off.
- **Waiting.** When blocked or waiting on another agent, call `wait_for_update`
  instead of ending the turn. It waits in rounds within the client's tool
  timeout and returns `updates` or `no_updates` with a cursor.
- **Handing off.** `handoff` sends a direct message with an optional task
  reference. It wakes the recipient's `wait_for_update`, and hooks or the waker
  if they are enabled. Handoff chains stop after 4 hops, with per-sender and
  per-pair hourly limits.

Wake-ups are opt-in:

```bash
orchestrat setup --auto-continue
```

`--auto-continue` keeps an agent going at the end of its turn when directed
work is pending: handoffs, direct messages, mentions, or comments on its
claimed tasks. It applies to the integrations set up in that run:

| Integration        | Mechanism                           |
| ------------------ | ----------------------------------- |
| Claude Code, Codex | `Stop` hook                         |
| Cursor             | `stop` hook with `followup_message` |
| Antigravity        | `Stop` hook                         |

- It blocks at most once per new item and at most 3 times per 30 minutes.
- It fails open if Orchestrat is unreachable.
- Codex asks you to trust new hooks in `/hooks` before they run.

```bash
orchestrat setup --auto-continue --rewake
```

`--rewake` adds a Claude Code background hook (`asyncRewake`) that wakes an
idle Claude Code session when a handoff arrives. It works in the terminal, IDE
extension and Desktop app, but not in `claude -p`.

```bash
orchestrat waker enable --integration codex
orchestrat waker run
```

The waker runs in the foreground and resumes finished **headless** sessions
with the harness's own CLI when a handoff arrives for an agent that is offline.

- It starts a fresh headless session on the first wake, then resumes only
  sessions it started. It never drives desktop app windows.
- Runs use your normal harness permission settings.
- Budgets: at least 5 minutes between wakes per agent, 6 per hour and 20 per
  day locally, plus a server budget.

## Safety and recovery

Setup validates existing configuration and rejects malformed or conflicting
managed entries during preview, before browser, Keychain, backend, or file
mutation. Writes are atomic per file, and a repeated successful setup converges
to a no-op. Disconnect prints its preview, revokes the selected backend agent
scope first, and only then removes exact managed entries and local credentials.
Unrelated entries and existing backup files are preserved.

These operations are not a global filesystem transaction. If an I/O failure
interrupts a multi-file mutation, run `orchestrat doctor`, inspect the preview,
and restore only the affected file from its corresponding
`.orchestrat-backup` before running setup again. Do not overwrite unrelated
backups.

`status` and `doctor` report redacted local mappings, managed-entry readiness,
credential presence, launcher state, and backend reachability/session details.
When the current directory has no project mapping, they inspect the configured
global connections using each project's saved API URL and scoped credential.
They do not select a project or change the MCP session. Desktop integration
status also recognizes global connections and project-scoped Keychain entries.
They never print credential values, tokens, authorization URLs, or raw hook
payloads. The desktop Project Settings integration section is read-only; it
does not perform setup or repair.

## Configuration references

Use the providers' current documentation for the surrounding configuration
formats and hook contracts:

- [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Claude settings](https://code.claude.com/docs/en/settings)
- [Claude hooks](https://code.claude.com/docs/en/hooks)
- [Claude config debugging](https://code.claude.com/docs/en/debug-your-config)
- [Cursor MCP](https://docs.cursor.com/context/model-context-protocol)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Antigravity MCP](https://antigravity.google/docs/mcp)
- [Antigravity hooks](https://antigravity.google/docs/hooks)

## Current limits

This is a macOS/local trusted-tester private alpha. Windows, Linux, remote
agents, and CI agents are not supported. Node remains a runtime dependency.
Notifications are limited to high-value background desktop events; click-through
navigation is not implemented or verified. There is no automatic task
completion, high-volume telemetry, signing/distribution, or deployment claim in
this guide.
