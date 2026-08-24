# Local agent setup (private alpha)

This guide covers the current macOS/private-alpha path for connecting supported
coding agents to one Orchestrat project. It is for trusted testers running from
the intended project directory. The CLI requires Node.js 20+ and installs a
self-contained managed runtime under `~/.orchestrat/runtimes` with a stable
`~/.local/bin/orchestrat` launcher. Official registry distribution is not yet
verified; use the [private-alpha runbook](private-alpha-runbook.md) for release
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

Setup detects installed Claude Code, Codex, Cursor, Antigravity, OpenCode, and
Pi commands, then asks which configurable agents to connect. Before any
mutation it prints the paths and managed entries that will change. It then
opens browser authorization, asks for the project scope, creates a separate
project-scoped agent identity and credential per selected integration, and
stores those credentials in separate macOS Keychain entries. The persistent
launcher is `~/.local/bin/orchestrat`; the local project and agent mapping is
non-secret metadata.

Claude Code, Codex, Cursor, and Antigravity receive MCP and lifecycle-hook
configuration. OpenCode receives MCP configuration only because it has no
stable native lifecycle-hook contract. Pi is detected and reported, but is not
selectable because it has no stable built-in MCP configuration path.

Managed files are:

- `~/.orchestrat/config.json`
- `~/.codex/config.toml`
- `~/.codex/hooks.json`
- `~/.claude.json`
- `~/.claude/settings.json`
- `~/.cursor/mcp.json`
- `~/.cursor/hooks.json`
- `~/.gemini/config/mcp_config.json`
- `~/.gemini/config/hooks.json`
- `~/.config/opencode/opencode.json`

Each changed file may have a sibling `.orchestrat-backup`. Credentials never
belong in the JSON/TOML config or mapping.

## Daily commands

```bash
orchestrat setup
orchestrat status
orchestrat doctor
orchestrat disconnect codex
orchestrat disconnect claude-code
orchestrat disconnect cursor
orchestrat disconnect antigravity
orchestrat disconnect opencode
orchestrat disconnect all
```

`hook` and `mcp` are managed integration commands installed by setup; they are
not ordinary manual workflows. Hooks report only low-volume normalized
`session.started`, `session.ended`, and `run.failed` lifecycle events. Session
end and failure never complete or assign a task.

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
- [OpenCode v2 MCP](https://opencode.ai/v2/docs/mcp-servers)

## Current limits

This is a macOS/local trusted-tester private alpha. Windows, Linux, remote
agents, and CI agents are not supported. Node remains a runtime dependency.
Notifications are limited to high-value background desktop events; click-through
navigation is not implemented or verified. There is no automatic task
completion, high-volume telemetry, signing/distribution, or deployment claim in
this guide.
