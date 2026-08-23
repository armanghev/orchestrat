# Local agent setup (private alpha)

This guide covers the current macOS/private-alpha path for connecting Codex and
Claude Code to one Orchestrat project. It is for trusted testers running from
the intended project directory. The CLI currently requires Node.js; the stable
launcher is a link to the installed CLI entry point. A raw checkout does not
automatically provide an executable `orchestrat`: trusted testers need a
tester-provided local package/bootstrap that exposes the CLI. Official registry
distribution is not verified.

## Prerequisites

- macOS and Node.js 20.19+ (or 22.12+).
- A tester-provided local package/bootstrap that exposes the CLI and its dependencies.
- An Orchestrat account and access to the target project.
- `ORCHESTRAT_API_URL` may override the API; the default is
  `https://api.orchestrat.dev`.
- Use only the browser authorization flow and API endpoint intended for trusted
  private-alpha testing. Do not paste credentials into config files or logs.

Run setup from the project directory whose mapping should be used:

```bash
orchestrat setup
```

Setup detects installed `codex` and `claude` commands and stops if neither is
available. Before any mutation it prints the paths and managed entries that
will change. It then opens browser authorization, asks for the project scope,
creates a separate project-scoped agent identity and credential per detected
integration, and stores those credentials in separate macOS Keychain entries.
The persistent launcher is `~/.local/bin/orchestrat`; the local project and
agent mapping is non-secret metadata.

Managed files are:

- `~/.orchestrat/config.json`
- `~/.codex/config.toml`
- `~/.codex/hooks.json`
- `~/.claude.json`
- `~/.claude/settings.json`

Each changed file may have a sibling `.orchestrat-backup`. Credentials never
belong in the JSON/TOML config or mapping.

## Daily commands

```bash
orchestrat setup
orchestrat status
orchestrat doctor
orchestrat disconnect codex
orchestrat disconnect claude-code
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

## Current limits

This is a macOS/local trusted-tester private alpha. Windows, Linux, remote
agents, and CI agents are not supported. Node remains a runtime dependency.
There is no automatic task completion, high-volume telemetry, notification
system, signing/distribution, or deployment claim in this guide.
