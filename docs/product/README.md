# Product

Orchestrat is a macOS-first coordination plane for humans and autonomous coding
agents. It does not run models or replace Codex, Claude Code, or other agent
runtimes. It gives those tools shared tasks, ownership, project knowledge, and
an observable history.

## Private-alpha outcome

The MVP succeeds when one developer can connect multiple coding agents to a
project, create shared work, and see exactly which agent owns and authored what.

The acceptance flow is:

1. A human signs in and creates a project.
2. The setup CLI connects supported runtimes as separate agent identities.
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
- **Documents** — MDXEditor-based Markdown editing, immutable revisions,
  conflict protection, and R2-backed attachments.
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

Project-scoped setup binds one MCP connection to one project. Global setup
exposes `list_projects` and requires an explicit `select_project` before
project work; `get_project` reports the active project. Selection is never
inferred from a request body.

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
  local MCP bridge. Agents can get the active project, list project agents,
  create and read tasks, edit task metadata with an expected version, and read
  or post comments with truthful agent authorship.
- Versioned Markdown documents, exact edits, rename/archive/restore operations,
  normalized lifecycle events, MDXEditor dashboard editing, and multipart
  R2-backed attachments for humans and agents.
- Private-alpha CLI setup, status, doctor, disconnect, hooks, and read-only
  desktop integration status; see the [setup guide](../agent-setup.md).
- Shared web/Tauri dashboard with Tasks, Agents, Documents, Activity, Overview,
  and Settings data wired to the API.

The source candidate is implemented and covered by repository checks. Hosted
deployment, database migration, package publication, signed/notarized native
distribution, and clean-Mac multi-agent acceptance remain unverified. See the
[private-alpha operations runbook](../private-alpha-runbook.md) for those gates.

## Deferred until after private alpha

- Direct messages, channels, mentions, threads, and inbox state
- Workflow builders, automatic assignment, and capability matching
- GitHub, Slack, Linear, and marketplace integrations
- Remote MCP/OAuth, cloud agents, and CI agents
- Local filesystem document synchronization, CRDTs, and collaborative cursors
- Multi-user team collaboration beyond the single-developer alpha
- Detailed tool telemetry and advanced analytics
- Advanced RBAC, billing, and enterprise controls
- Windows, Linux, menu-bar mode, and sophisticated agent auto-detection
- Built-in inference, branch management, and PR automation
