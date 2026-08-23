# Product

Orchestrat is a macOS-first coordination plane for humans and autonomous coding
agents. It does not run models or replace Codex, Claude Code, or other agent
runtimes. It gives those tools shared tasks, ownership, project knowledge, and
an observable history.

## Private-alpha outcome

The MVP succeeds when a developer can connect Codex and Claude Code to one
project, create shared work, and see exactly which agent owns what.

The acceptance flow is:

1. A human signs in and creates a project.
2. The setup CLI connects Codex and Claude Code as separate agent identities.
3. Both agents discover the same ready task.
4. They attempt to claim it, but exactly one succeeds.
5. The winner heartbeats, comments, updates shared Markdown, and completes it.
6. The macOS app shows presence, task state, document revisions, and activity.
7. If the winner disappears, its lease expires and another agent can claim.

The product becomes useful at the second connected agent: the user can see what
each agent owns and what work remains available without managing terminals by
memory.

## MVP surfaces

The macOS app and web dashboard share one React frontend with these routes:

- **Overview** — online, busy, idle, and blocked agents; active work; tasks
  needing attention; recent events.
- **Tasks** — project tasks, priorities, dependencies, exclusive claims,
  comments, and optimistic versions.
- **Agents** — runtime, presence, current session, heartbeat, current task, and
  recent activity.
- **Documents** — shared Markdown files with immutable revisions and conflict
  protection.
- **Activity** — durable meaningful project events, not a stream of every tool
  call.
- **Settings** — project and local integration status.

Task comments cover MVP human-agent and agent-agent coordination. Full messaging
is deliberately deferred.

## Agent connection model

`orchestrat setup` bootstraps a persistent local `orchestrat` executable from
the locally installed Node CLI. It provides a generic stdio MCP bridge and
lightweight lifecycle hooks for both Codex and Claude Code; see the
[private-alpha setup guide](../agent-setup.md).

Each integration has its own project-scoped, revocable credential stored in
macOS Keychain. Agent configuration files contain no API secrets. The backend
derives agent and project identity from the credential rather than trusting IDs
inside request bodies.

MCP is for intentional actions such as claiming work, commenting, updating a
document, or completing a task. Hooks report lifecycle signals such as session
start, stop, and failure; hooks do not make task-completion decisions.

## Active hierarchy

The durable hierarchy is:

```text
Organization -> Project
```

First-run onboarding may create a personal organization automatically. There is
no active Workspace layer and the MVP does not ask users to configure one.

## Current implementation

Implemented today:

- Supabase human authentication for web and Tauri, including GitHub OAuth,
  magic links, deep-link callbacks, and native Keychain session ownership.
- Organization and project management with membership authorization.
- Human Tasks API for create/list/detail/update/move, comments, dependencies,
  idempotent creation, and optimistic concurrency.
- Agent credentials, sessions, heartbeat, presence, exclusive claims, and the
  local MCP bridge.
- Versioned Markdown documents and normalized lifecycle events.
- Private-alpha CLI setup, status, doctor, disconnect, hooks, and read-only
  desktop integration status; see the [setup guide](../agent-setup.md).
- Shared web/Tauri dashboard shell.

Still planned:

- Dashboard wiring for Tasks and every agent-facing surface.
- Activity and project-scoped realtime delivery.
- Notifications and alpha distribution.

The current Tasks API migration and full end-to-end native flow still require
verification against the production-like PostgreSQL and macOS environments.

## Deferred until after private alpha

- Direct messages, channels, mentions, threads, and inbox state
- Workflow builders, automatic assignment, and capability matching
- GitHub, Slack, Linear, and marketplace integrations
- Remote MCP/OAuth, cloud agents, and CI agents
- Rich text, CRDTs, and collaborative cursors
- Detailed tool telemetry and advanced analytics
- Advanced RBAC, billing, and enterprise controls
- Windows, Linux, menu-bar mode, and sophisticated agent auto-detection
- Built-in inference, branch management, and PR automation
