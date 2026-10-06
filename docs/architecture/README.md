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
Organization -> Project -> Branch
```

Organization membership grants project access. No client-supplied organization
or project ID is trusted without resolving membership. The removed Workspace
layer remains only in historical migrations and is not restored for the MVP.

Branches split a project's work, not its access. Members, roles, agents and
agent credentials are project-wide, and any member or agent of a project can
work on any of its active branches. See [Branches](#branches--current).

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

A project-scoped connection also follows the Git checkout's branch. The CLI
reads the branch from `.git` files without starting a `git` process, registers
it with the API, and pins the MCP session to it. Hooks send the same branch in
a header. See the [agent setup guide](../agent-setup.md#branches).

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

Tasks belong to one branch of a project and use a monotonically increasing
`version` for optimistic concurrency. Kanban positions are ordered within
status, moves can insert before an anchor, comments are Markdown, and
dependency edges cannot cross branches or form cycles. Archived projects and
archived branches allow reads but reject writes. Task numbers come from one
project-wide counter, and keys are unique per branch, so a copied task keeps
its key on every branch.

Human mutations cannot select `claimed`. Agent claim routes and services enforce
exclusive ownership through the database claim table and partial constraints.

### Current

Claims are exclusive leases tied to an agent and session. Claiming, renewing,
releasing, expiring, and completing work must update the task and claim record
transactionally. PostgreSQL enforces at most one active claim per task. A
session is pinned to one branch, and it can only claim tasks on that branch.

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

Documents are Markdown identified by path within their branch. Content changes
create immutable revisions. A writer supplies `base_revision`; a stale write
returns `DOCUMENT_CONFLICT` with the current and supplied revisions.

The dashboard edits Markdown with MDXEditor. Human and agent routes also support
exact text edits, path changes, archive/restore, and multipart attachments in
R2-compatible object storage. Upload metadata remains in PostgreSQL and access
is authorized through the owning document and project.

This prevents lost updates without CRDTs, collaborative cursors, local
filesystem synchronization, or a separate document service.

## Branches — current

Project branches follow Git. The design is in
[`docs/project-branches.md`](../project-branches.md).

A branch is a row in `project_branches`, and its name is a Git branch name.
These tables carry `branch_id`: tasks, task comments, dependencies, claims,
agent sessions, documents, folders, revisions, attachments, attachment
uploads, chats, chat participants and chat messages. Composite foreign keys
keep every child row on its parent's branch. Migration
`0016_project_branches.sql` gave every project a default branch named `main`
and moved every existing row onto it with its ID unchanged.

Branches are created in three ways:

- the CLI or MCP registers the Git checkout's branch when an agent works
  there, even if the branch was never pushed;
- a person creates one in the dashboard;
- a connected repository creates one when a branch is created or pushed.

Each request resolves one branch in
`apps/api/src/services/branch-context.ts`: a pinned agent session, else an
explicit branch (`?branch_id=` for people, `X-Orchestrat-Branch-Id` for
agents), else the default branch. Entity routes take the branch from the row.
Requests that name no branch use the default branch, so clients from before
branches keep working. Branch rules live in `branch-context.ts` and
`branch-service.ts`, flat files beside the other services.

Two pieces cover the rollout window, when the hosted database already runs
`0016` but the old API may still be serving:

- A plpgsql trigger in `0016` fills `branch_id` with the default branch for
  inserts that don't set it. A later cleanup migration drops it (ORC-46).
- The default branch is repaired lazily: a project created without one gets
  it the first time its default branch is read. There is no repair at boot.

Archived branches are read-only, hidden by default, and never become active
again. Archiving closes the branch's agent sessions and revokes their claims.
Nothing is deleted, and the default branch can't be archived. Owners and
admins set the default, archive and merge. Provider automation also archives
branches deleted on the provider, merges merged pull requests, and moves the
default branch when the provider's default moves and the Orchestrat default
tracked the old one.

Every branch write keeps the existing project-row `FOR UPDATE` lock. That
keeps `project_events.id` order equal to commit order across branches, which
realtime catch-up relies on.

## Merge engine — current

One engine in `apps/api/src/services/merges/` runs imports, manual merges and
provider merges.

- **Lineage.** A copied row records `origin_id`, so `coalesce(origin_id, id)`
  names the same logical item on every branch. Items match by lineage, or by a
  natural key: a document's path or a direct message's participant pair.
- **Three-way rule.** Tasks, documents and chats are compared with per-field
  fingerprints against a baseline, the last state both branches agreed on.
  Baselines live in `branch_item_baselines`, keyed by the sorted branch pair,
  so one baseline serves both directions. If only the source changed, its
  changed fields apply. If only the target changed, the target is kept. If
  both changed, the item is a conflict and the target is kept whole. Stacked
  branches inherit baselines, so `main → feat1 → feat2` merges back without
  false conflicts.
- **Conflicts.** An import asks the person to choose for each conflict before
  it applies. A merge keeps the target's version and records a decision in
  `branch_merge_decisions` for an owner or admin to resolve.
- **What never happens.** Deletions never propagate. A task with an active
  claim on the target is never modified. Claims, sessions and events are never
  copied. Chat participants are never added, and messages are appended only
  when that would not widen who can read the chat. Copied comments and
  messages carry `imported_at` and never notify.
- **Plan and apply.** `plan()` reads without locks and returns a preview with a
  fingerprint. `apply()` copies attachment objects first, then re-plans under
  the project lock and writes everything in one transaction. A changed
  fingerprint means a stale preview. A failed apply leaves no rows, and the
  objects it copied are deleted. Each run records a `branch_merge_runs` row and
  emits one summary event.
- **Document content.** The engine reads revision content from the database
  row and writes copied revisions inline.
- **Repeats.** Dashboard applies replay through `Idempotency-Key`, stored in
  `api_idempotency_keys` with operation `branch_apply`. Provider merges dedupe
  on one key per merged change, so a redelivered webhook is a no-op.

## Repository sync — current

A project can connect one repository on GitHub, GitLab.com or Cursor Origin.
Provider code lives in `apps/api/src/services/repository/providers/`; the rest
of `services/repository/` doesn't depend on the provider.

```text
provider ──HTTPS──> POST /api/v1/webhooks/<provider>[/:connectionId]
                      verify the signature on the raw body
                      INSERT repository_webhook_deliveries ──> 202
                                  │
RepositorySyncWorker (inside the API process, one replica)
  every 2 s: apply pending deliveries in received order
  about every 15 min: reconcile each active connection
```

- **Webhook inbox.** A webhook is verified, stored once per provider delivery
  ID, and answered fast. Nothing touches branches when it arrives.
- **Worker.** When repository sync is enabled, `RepositorySyncWorker`
  (`sync-worker.ts`) runs in process. It starts when the server listens and
  stops before shutdown, after the tick in flight. One tick runs at a time,
  and each delivery is claimed with an optimistic update. A failed delivery retries with exponential backoff, capped
  at one hour, and is marked `failed` after 10 attempts; an owner or admin can
  retry it from settings. On boot, deliveries stuck in `processing` for more
  than 5 minutes go back in line. There is no queue service and no
  `SKIP LOCKED`, so the API must run as a single replica.
- **Reconcile.** About every 15 minutes per connection (±20%,
  `ORCHESTRAT_REPOSITORY_RECONCILE_INTERVAL_SECONDS`), and on connect and
  **Sync now**, the worker re-reads the repository, its branches, and merged
  changes since the last watermark minus an hour. Lost and out-of-order events
  converge here.
- **Branch sync.** Provider events are hints. A delete is confirmed with the
  provider before anything is archived. `repository_refs` keeps one row per
  generation of a branch name, so a deleted and recreated branch gets a new
  Orchestrat branch. A new provider branch links an active Orchestrat branch of
  the same name that nothing tracks yet, or creates one. A provider delete
  never archives the default branch.
- **Merged pull requests.** A merged PR or MR runs the merge engine from the
  head's branch into the base's branch, and conflicts become decisions. The
  head may already be deleted: a deleted generation with the merged head still
  counts for 7 days. Merges from forks change nothing; they are recorded as
  skipped runs.
- **Secrets.** GitLab's access, refresh and signing tokens are the only
  provider secrets kept after connecting. They are encrypted with AES-256-GCM
  and bound to their row and purpose. GitHub and Origin installation tokens
  are minted with the narrowest scope and kept in memory only.
- **Configuration.** `packages/config/src/repository.ts` reads the environment.
  A provider is offered only when all of its variables are set, and
  `ORCHESTRAT_REPOSITORY_SYNC_ENABLED` defaults to on when any provider is. See
  the [provider setup guide](../project-branches-provider-setup.md).

## Events and activity — current

Meaningful state changes insert ordered, project-scoped events in the same
database transaction as their domain mutation. Examples include agent
connections, task claims, comments, failures, completions, and document
updates.

Routes, MCP handlers, and hook ingestion all call the same application services.
Transport handlers do not independently construct activity or broadcast state.

Events carry the branch they happened on. Project-wide events, such as branch,
repository, agent and credential events, carry none. A branch's feed shows its
own events plus the project-wide ones. An import or merge emits one summary
event, never one per copied item.

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

There is one socket per project for every branch. Envelopes carry `branch_id`,
and the server doesn't filter by branch. The dashboard catches up across all
branches (`all_branches=true`) to keep one cursor. It then refreshes only the
event's branch; an event without a branch refreshes every branch.

Start with one API replica and an in-memory map of project connections. Redis
Pub/Sub is added only when multiple API replicas exist. The repository sync
worker also assumes one replica.

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
- keep every child row on its parent's branch, and never let a header move a
  pinned session to another branch
- verify provider webhooks on the raw body before storing them

## Remaining private-alpha gates

The source candidate contains the API, CLI/MCP, dashboard, realtime, document,
attachment, and native packaging paths. Package publication, hosted deployment
and migration, R2 production configuration, signed/notarized DMG distribution,
and clean-Mac multi-agent acceptance are not verified by the source checkout.
The [operations runbook](../private-alpha-runbook.md) tracks those gates.

Project branches add their own: migrating the hosted database to `0016`, live
acceptance against GitHub, GitLab.com and Cursor Origin, and the migration
that drops the rollout trigger. The
[branches acceptance record](../acceptance/2026-09-30-project-branches.md)
lists what ran and what didn't.
