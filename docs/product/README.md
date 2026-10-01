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
- **Decisions** — conflicts that merges left on a branch, for an owner or admin
  to settle by keeping the source or the target version.
- **Settings** — project, branches, repository connection, and local
  integration status.

Every project page shows one branch, chosen in the toolbar breadcrumb:
Organization › Project › Branch › Page.

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
Organization -> Project -> Branch
```

First-run onboarding may create a personal organization automatically. There is
no active Workspace layer and the MVP does not ask users to configure one.

## Branches

A project's work lives on branches that follow Git. Each branch has its own
tasks with comments and dependencies, documents with folders, revisions and
attachments, chats, and agent sessions. Members, roles, agents and credentials
stay project-wide. The design is in
[`docs/project-branches.md`](../project-branches.md).

- **Default branch.** Every project has exactly one. Work from before branches
  lives on it, and any client that names no branch, including older CLI
  versions, reads and writes there. Owners and admins can change it.
- **Creating.** A branch appears when an agent starts in a Git checkout on a
  new branch, even one never pushed; when a member creates one in the
  dashboard; or when a branch is created or pushed on a connected repository.
- **Setting up.** A new branch starts blank, or imports everything or chosen
  items from another branch. An import brings the tasks a chosen task depends
  on, and asks the person to choose a version for each conflict.
- **Merging.** When a pull or merge request is merged on the connected
  repository, Orchestrat merges the head branch's work into the base branch.
  Owners and admins can also merge by hand. Items changed only on the source
  apply. Items changed on both sides keep the target version and wait under
  **Needs your decision**, where an owner or admin keeps the source or the
  target.
- **Archiving.** A branch deleted on the provider is archived, and owners and
  admins can archive by hand. Archived branches are read-only and hidden by
  default. Nothing is deleted, and their work can still be imported into
  another branch. Archiving closes the branch's agent sessions.
- **Repository connections.** A project can connect one repository on GitHub,
  GitLab.com or Cursor Origin. Orchestrat reads branches and merged pull
  requests, and never creates, deletes or merges branches on the provider.
- **Agents.** Agents follow their Git checkout's branch, and can list and
  switch branches with `list_branches` and `select_branch`. Local Git never
  merges, archives or deletes anything in Orchestrat; see the
  [setup guide](../agent-setup.md#branches).
- **Visibility.** Imports and merges never show anyone a chat they couldn't see
  before, and copied history never shows up as unread.

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
  Decisions, and Settings data wired to the API.
- Project branches: per-branch tasks, documents, chats and agent sessions; a
  CLI and MCP that follow the Git checkout's branch; imports, manual merges and
  merges driven by merged pull requests, with decisions for conflicts; and
  repository connections for GitHub, GitLab.com and Cursor Origin.

The source candidate is implemented and covered by repository checks. Hosted
deployment, database migration, package publication, signed/notarized native
distribution, and clean-Mac multi-agent acceptance remain unverified. See the
[private-alpha operations runbook](../private-alpha-runbook.md) for those gates.
Repository connections are tested only against simulated providers, and the
hosted database is not yet migrated for branches; see the
[branches acceptance record](../acceptance/2026-09-30-project-branches.md).

## Deferred until after private alpha

- Direct messages, channels, mentions, threads, and inbox state
- Workflow builders, automatic assignment, and capability matching
- Slack, Linear, and marketplace integrations
- Pull request comments, statuses, checks and approvals, and any change to a
  connected repository's branches or code
- Self-hosted GitLab, GitHub Enterprise Server, other forges, pull requests
  from forks, Cursor Origin mirrors of GitHub repositories, and more than one
  repository per project
- Per-branch permissions, restoring archived branches, and hand-editing merge
  conflicts
- Remote MCP/OAuth, cloud agents, and CI agents
- Local filesystem document synchronization, CRDTs, and collaborative cursors
- Multi-user team collaboration beyond the single-developer alpha
- Detailed tool telemetry and advanced analytics
- Advanced RBAC, billing, and enterprise controls
- Windows, Linux, menu-bar mode, and sophisticated agent auto-detection
- Built-in inference
