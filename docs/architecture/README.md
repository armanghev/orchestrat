# Architecture

Orchestrat is a hosted coordination service with a local macOS bridge. Coding
agents remain inside Codex, Claude Code, or another runtime; Orchestrat supplies
shared state, exclusive claims, project documents, and an observable event log.

Sections marked **Current** describe implemented source. Hosted deployment,
native distribution, and clean-Mac multi-agent acceptance remain separate,
unverified private-alpha gates.

## System shape — current source candidate

```text
Codex / Claude Code
  -> stdio MCP + command hooks
persistent orchestrat CLI
  -> authenticated HTTPS
Fastify routes
  -> application services
  -> PostgreSQL transaction
     -> domain state + ordered event
  -> post-commit realtime notification
web + Tauri dashboard
```

Deployments remain separate:

```text
orchestrat.dev       -> Next.js landing on Vercel
app.orchestrat.dev   -> Vite/React dashboard on Vercel
api.orchestrat.dev   -> one persistent Fastify service
PostgreSQL           -> hosted Supabase database through Drizzle
```

The dashboard never accesses application tables through PostgREST. Fastify is
the authorization and application-service boundary, while PostgreSQL remains
authoritative.

## Application boundaries — current

Routes validate shared Zod contracts from `@orchestrat/protocol` and delegate
to services under `apps/api/src/services`. Services own authorization-sensitive
business behavior and use Drizzle through `@orchestrat/db`.

The active hierarchy is:

```text
Organization -> Project
```

Organization membership grants project access. No client-supplied organization
or project ID is trusted without resolving membership. The removed Workspace
layer remains only in historical migrations and is not restored for the MVP.

Project-specific membership waits until access must be narrower than the
organization boundary.

## Human authentication — current

Web and Tauri users authenticate through Supabase. The API validates issuer,
audience, expiry, and authenticated role before resolving the Supabase subject
to a local user.

The Tauri auth service owns refresh tokens in macOS Keychain and gives the React
renderer only short-lived access grants. GitHub OAuth and magic-link flows use
the system browser, PKCE, deep-link callbacks, and a single-instance native app.

Human requests use:

```http
Authorization: Bearer <Supabase access token>
```

## Agent identity and local bridge — current

Each integration is a distinct agent with a distinct project-scoped,
revocable credential:

```text
working directory + integration name
  -> local project mapping
  -> agent identity
  -> matching Keychain credential
```

Agent configuration contains only a command such as:

```text
orchestrat mcp --integration codex
orchestrat mcp --integration claude-code
```

The persistent CLI retrieves the secret from Keychain and calls Fastify over
HTTPS. The backend derives agent and project scope from the credential and does
not accept arbitrary body IDs as authority.

When the MCP bridge starts, it opens an agent session and retains the session ID
in memory. Dedicated heartbeats and valid hook activity update presence. The
bridge closes the session on exit when possible; stale sessions are ultimately
resolved by heartbeat expiry.

The same credential boundary serves long-lived MCP calls and short-lived hook
commands. Remote MCP and standardized MCP OAuth are deferred.

A project-scoped MCP connection has one configured project. A global MCP
connection can list authorized projects but must explicitly select one before
project tools run. The selected credential remains the authority, and
`get_project` returns the corresponding project from the API.

## Local setup — private alpha

`orchestrat setup` uses the locally installed Node CLI to create the persistent
executable and authorize it through the browser. The CLI receives an
Orchestrat credential, not the human's Supabase refresh token. See the
[private-alpha setup guide](../agent-setup.md) for package/bootstrap limits.

For Codex and Claude Code configuration, setup:

1. inspect existing files
2. preview the planned changes
3. create a backup
4. merge only missing Orchestrat entries
5. write with a temporary file and atomic rename
6. verify the resulting configuration

Setup is idempotent. Disconnect removes only Orchestrat-managed entries and
revokes the relevant credentials. For the private alpha, the CLI owns config
mutation; Tauri only displays integration status.

Non-secret working-directory mappings may live in
`~/.orchestrat/config.json`. Credentials never do.

## Tasks and claims

### Current

Tasks are project-scoped and use a monotonically increasing `version` for
optimistic concurrency. Kanban positions are ordered within status, moves can
insert before an anchor, comments are Markdown, and dependency edges cannot
cross projects or form cycles. Archived projects allow reads but reject writes.

Human mutations cannot select `claimed`. Agent claim routes and services enforce
exclusive ownership through the database claim table and partial constraints.

### Current

Claims are exclusive leases tied to an agent and session. Claiming, renewing,
releasing, expiring, and completing work must update the task and claim record
transactionally. PostgreSQL enforces at most one active claim per task.

Two concurrent claim attempts must produce one success and one stable conflict,
never two apparent owners. Expired claims become available without requiring a
second-by-second scheduler; expiration may be reconciled when tasks are read or
claimed until volume proves a worker is necessary.

Agents use the same task service to list and read tasks, create backlog or ready
tasks, edit title/description/priority with `expected_version`, and read or add
Markdown comments. Those metadata edits cannot change claim ownership or task
status. Task and comment records retain a discriminated human or agent author;
historical human authors remain intact.

## Documents — current

Documents are project-scoped Markdown identified by path. Content changes create
immutable revisions. A writer supplies `base_revision`; a stale write returns
`DOCUMENT_CONFLICT` with the current and supplied revisions.

The dashboard edits Markdown with MDXEditor. Human and agent routes also support
exact text edits, path changes, archive/restore, and multipart attachments in
R2-compatible object storage. Upload metadata remains in PostgreSQL and access
is authorized through the owning document and project.

This prevents lost updates without CRDTs, collaborative cursors, local
filesystem synchronization, or a separate document service.

## Events and activity — current

Meaningful state changes insert ordered, project-scoped events in the same
database transaction as their domain mutation. Examples include agent
connections, task claims, comments, failures, completions, and document
updates.

Routes, MCP handlers, and hook ingestion all call the same application services.
Transport handlers do not independently construct activity or broadcast state.

Fine-grained tool telemetry is separate from the durable user-facing Activity
feed and waits until real usage justifies its storage and retention policy.

## Realtime — current

WebSockets are a notification layer, not reliable storage. Services publish
only after their database transaction commits.

Human clients obtain a random, short-lived, single-use, project-scoped ticket:

```text
POST /api/v1/realtime/tickets
  -> wss://api.orchestrat.dev/api/v1/realtime/projects/:projectId?ticket=...
```

Supabase access tokens do not appear in WebSocket URLs. Ticket creation verifies
human authentication and project membership; upgrade consumes the ticket.

Every durable event has a project sequence. A reconnecting client requests
events after its last sequence, then invalidates affected TanStack Query caches.
REST remains usable while the socket is disconnected.

Start with one API replica and an in-memory map of project connections. Redis
Pub/Sub is added only when multiple API replicas exist.

## Hooks and activity safety — current

MCP performs intentional actions. Hooks normalize automatic lifecycle signals
such as session start, stop, and failure. A hook credential determines its agent
and project; body values do not.

A stop hook never marks a task complete because a stopped run may be blocked,
interrupted, failed, or awaiting input. Completion remains an explicit MCP
action.

## Errors and correctness — current and target

Every HTTP response carries `x-request-id`; errors use the shared structured
envelope. Human and agent task/comment creation is principal-scoped and
idempotent, and task/document updates use expected versions.

Security and correctness checks that remain mandatory:

- hash stored agent credentials and support revocation
- scope every credential to one agent and project
- validate every transport at the trust boundary
- enforce exclusive claims in PostgreSQL
- insert events inside the domain transaction
- broadcast only after commit
- reject stale document revisions
- keep Keychain secrets out of config, URLs, logs, and the renderer

## Remaining private-alpha gates

The source candidate contains the API, CLI/MCP, dashboard, realtime, document,
attachment, and native packaging paths. Package publication, hosted deployment
and migration, R2 production configuration, signed/notarized DMG distribution,
and clean-Mac multi-agent acceptance are not verified by the source checkout.
The [operations runbook](../private-alpha-runbook.md) tracks those gates.
