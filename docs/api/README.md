# API

Authenticated routes live under `/api/v1` and require a human Supabase access
token:

```http
Authorization: Bearer <session-token>
```

## Endpoints

| Method   | Path                                                                   | Behavior                                                                               |
| -------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET`    | `/health`                                                              | Public service health                                                                  |
| `GET`    | `/api/v1/health`                                                       | Public versioned service health                                                        |
| `GET`    | `/api/v1/profile`                                                      | Get the authenticated user's profile                                                   |
| `PATCH`  | `/api/v1/profile`                                                      | Update username, full name, or avatar URL                                              |
| `POST`   | `/api/v1/profile/avatar`                                               | Upload a JPEG, PNG, or WebP avatar (maximum 2 MiB); requires configured object storage |
| `DELETE` | `/api/v1/profile/avatar`                                               | Remove the current avatar                                                              |
| `GET`    | `/api/v1/organizations`                                                | List the current user's organizations                                                  |
| `POST`   | `/api/v1/organizations`                                                | Create an organization and owner membership                                            |
| `GET`    | `/api/v1/organizations/:id`                                            | Get an accessible organization                                                         |
| `PATCH`  | `/api/v1/organizations/:id`                                            | Update an organization (owner or admin)                                                |
| `DELETE` | `/api/v1/organizations/:id`                                            | Delete an organization (owner; body must contain its current `name`)                   |
| `GET`    | `/api/v1/organizations/:organizationId/members`                        | List organization members                                                              |
| `PATCH`  | `/api/v1/organizations/:organizationId/members/:memberId`              | Update a member role (owner or admin, with owner safeguards)                           |
| `DELETE` | `/api/v1/organizations/:organizationId/members/:memberId`              | Remove a member (owner or admin, with owner safeguards)                                |
| `POST`   | `/api/v1/organizations/:organizationId/members/leave`                  | Leave an organization (the sole owner cannot leave)                                    |
| `GET`    | `/api/v1/organizations/:organizationId/projects`                       | List accessible projects in an organization                                            |
| `POST`   | `/api/v1/organizations/:organizationId/projects`                       | Create a project in an organization                                                    |
| `GET`    | `/api/v1/projects/:id`                                                 | Get an accessible project                                                              |
| `PATCH`  | `/api/v1/projects/:id`                                                 | Update project name, slug, or description (owner or admin)                             |
| `POST`   | `/api/v1/projects/:id/archive`                                         | Archive a project idempotently (owner or admin)                                        |
| `POST`   | `/api/v1/projects/:id/reactivate`                                      | Reactivate a project idempotently (owner or admin)                                     |
| `DELETE` | `/api/v1/projects/:id`                                                 | Delete a project (owner; body must contain its current `name`)                         |
| `POST`   | `/api/v1/projects/:projectId/tasks`                                    | Create a task (`Idempotency-Key` required)                                             |
| `GET`    | `/api/v1/projects/:projectId/tasks`                                    | List task cards with cursor pagination and filters                                     |
| `GET`    | `/api/v1/tasks/:id`                                                    | Get one task card                                                                      |
| `PATCH`  | `/api/v1/tasks/:id`                                                    | Update title, description, or priority with `expected_version`                         |
| `POST`   | `/api/v1/tasks/:id/move`                                               | Move a task to a status/position with `expected_version`                               |
| `GET`    | `/api/v1/tasks/:id/comments`                                           | List comments with cursor pagination                                                   |
| `POST`   | `/api/v1/tasks/:id/comments`                                           | Add a Markdown comment (`Idempotency-Key` required)                                    |
| `GET`    | `/api/v1/tasks/:id/dependencies`                                       | List tasks this task depends on and tasks it blocks                                    |
| `POST`   | `/api/v1/tasks/:id/dependencies`                                       | Add a dependency with `expected_version`                                               |
| `DELETE` | `/api/v1/tasks/:id/dependencies/:dependsOnTaskId`                      | Remove a dependency with `expected_version`                                            |
| `POST`   | `/api/v1/projects/:projectId/agents`                                   | Create a project agent (human project editor)                                          |
| `GET`    | `/api/v1/projects/:projectId/agents`                                   | List project agents (human project member)                                             |
| `POST`   | `/api/v1/projects/:projectId/agents/:agentId/revoke`                   | Revoke an agent and its active credentials, sessions, and claims                       |
| `POST`   | `/api/v1/projects/:projectId/agents/:agentId/credentials`              | Issue a credential; the token is returned only in this response                        |
| `GET`    | `/api/v1/projects/:projectId/credentials`                              | List project credentials without token values                                          |
| `POST`   | `/api/v1/projects/:projectId/credentials/:credentialId/revoke`         | Revoke a credential (human project editor)                                             |
| `GET`    | `/api/v1/projects/:projectId/presence`                                 | List project agent presence                                                            |
| `GET`    | `/api/v1/projects/:projectId/events`                                   | List ordered project events with an `after` cursor                                     |
| `GET`    | `/api/v1/projects/:projectId/documents`                                | List project Markdown documents with cursor pagination                                 |
| `POST`   | `/api/v1/projects/:projectId/documents`                                | Create a Markdown document and revision 1                                              |
| `GET`    | `/api/v1/documents/:id`                                                | Read a document and its current revision                                               |
| `PATCH`  | `/api/v1/documents/:id`                                                | Create a revision using an optimistic `base_revision`                                  |
| `POST`   | `/api/v1/documents/:id/edits`                                          | Apply exact text edits using an optimistic `base_revision`                             |
| `PATCH`  | `/api/v1/documents/:id/path`                                           | Rename a document path                                                                 |
| `POST`   | `/api/v1/documents/:id/archive`                                        | Archive a document                                                                     |
| `POST`   | `/api/v1/documents/:id/restore`                                        | Restore an archived document                                                           |
| `GET`    | `/api/v1/documents/:id/revisions`                                      | List immutable document revisions                                                      |
| `GET`    | `/api/v1/documents/:id/revisions/:revision`                            | Read one immutable revision                                                            |
| `GET`    | `/api/v1/documents/:documentId/attachments`                            | List document attachments                                                              |
| `POST`   | `/api/v1/documents/:documentId/attachments/uploads`                    | Start a direct multipart attachment upload                                             |
| `GET`    | `/api/v1/documents/:documentId/attachments/uploads/:uploadId`          | Inspect an attachment upload                                                           |
| `POST`   | `/api/v1/documents/:documentId/attachments/uploads/:uploadId/refresh`  | Refresh upload expiry and signed URLs                                                  |
| `POST`   | `/api/v1/documents/:documentId/attachments/uploads/:uploadId/parts`    | Sign multipart upload parts                                                            |
| `POST`   | `/api/v1/documents/:documentId/attachments/uploads/:uploadId/complete` | Complete and verify an upload                                                          |
| `DELETE` | `/api/v1/documents/:documentId/attachments/uploads/:uploadId`          | Abort an upload                                                                        |
| `POST`   | `/api/v1/documents/:documentId/attachments/:attachmentId/download`     | Create a short-lived download URL                                                      |
| `DELETE` | `/api/v1/documents/:documentId/attachments/:attachmentId`              | Delete an attachment                                                                   |

Agent-only routes use the `/api/v1/agent` prefix:

| Method  | Path                                                | Behavior                                                                   |
| ------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET`   | `/api/v1/agent/project`                             | Get the project fixed by the agent credential, with `default_branch_id`    |
| `POST`  | `/api/v1/agent/sessions`                            | Open a session with runtime, integration, and optional external session ID |
| `POST`  | `/api/v1/agent/sessions/:sessionId/heartbeat`       | Refresh a session and renew its active claim leases                        |
| `POST`  | `/api/v1/agent/sessions/:sessionId/close`           | Close a session and revoke its active claims                               |
| `GET`   | `/api/v1/agent/tasks`                               | List tasks in the credential's project with filters and cursor pagination  |
| `POST`  | `/api/v1/agent/tasks`                               | Create an agent-authored backlog or ready task idempotently                |
| `GET`   | `/api/v1/agent/tasks/:id`                           | Get a task in the credential's project                                     |
| `POST`  | `/api/v1/agent/tasks/bulk`                          | Create 1–50 tasks in one all-or-nothing, idempotent batch                  |
| `PATCH` | `/api/v1/agent/tasks/bulk`                          | Edit or move 1–50 distinct tasks in one all-or-nothing batch               |
| `PATCH` | `/api/v1/agent/tasks/:id`                           | Edit task metadata or move an unclaimed task with `expected_version`       |
| `GET`   | `/api/v1/agent/tasks/:id/comments`                  | Read human and agent comments                                              |
| `POST`  | `/api/v1/agent/tasks/:id/comments`                  | Add an agent-authored Markdown comment idempotently                        |
| `POST`  | `/api/v1/agent/tasks/:id/claim`                     | Claim a ready task with a session and lease duration                       |
| `POST`  | `/api/v1/agent/sessions/:sessionId/claims/release`  | Release an owned claim using its claim token                               |
| `POST`  | `/api/v1/agent/sessions/:sessionId/claims/complete` | Complete an owned claim using its claim token                              |
| `GET`   | `/api/v1/agent/presence`                            | List presence for the credential's project                                 |
| `GET`   | `/api/v1/agent/events`                              | List project events with an `after` cursor                                 |
| `GET`   | `/api/v1/agent/documents`                           | List documents in the credential's project with cursor pagination          |
| `POST`  | `/api/v1/agent/documents`                           | Create a document and revision 1 in the credential's project               |
| `GET`   | `/api/v1/agent/documents/:id`                       | Read a document in the credential's project                                |
| `PATCH` | `/api/v1/agent/documents/:id`                       | Create a revision in the credential's project                              |
| `POST`  | `/api/v1/agent/documents/:id/edits`                 | Apply exact text edits in the credential's project                         |
| `PATCH` | `/api/v1/agent/documents/:id/path`                  | Rename a document in the credential's project                              |
| `POST`  | `/api/v1/agent/documents/:id/archive`               | Archive a document in the credential's project                             |
| `POST`  | `/api/v1/agent/documents/:id/restore`               | Restore a document in the credential's project                             |
| `GET`   | `/api/v1/agent/documents/:id/revisions`             | List immutable revisions                                                   |
| `GET`   | `/api/v1/agent/documents/:id/revisions/:revision`   | Read one immutable revision                                                |

Agent document attachment routes mirror the human attachment suffixes under
`/api/v1/agent/documents/:documentId/attachments`. Both surfaces authorize
through the owning document and project; object bytes use configured
R2-compatible storage through short-lived signed URLs.

Tasks, documents, chats and agent sessions belong to a project branch. Branch,
merge, decision and repository routes, and the rules for choosing a branch,
are under [Branches](#branches).

Names are required. Slugs are optional and derived from names when omitted.
Project creation also accepts optional `task_key_prefix` (2–8 alphanumeric
characters, uppercased). Without it, the prefix is the first three
alphanumeric slug characters when at least two exist, otherwise `PRJ`.
Create endpoints return `201`; other successful operations return `200`.
Profile avatar upload expects multipart form data. The dashboard consumes the
task, agent, document, attachment, activity, and realtime routes.

## Tasks API

All `/api/v1` routes require `Authorization: Bearer <Supabase access token>`.
The token is verified, then resolved to a local user; organization membership
grants project and task access. Missing or invalid authentication returns
`401 UNAUTHENTICATED`. A user without project membership receives
`403 PERMISSION_DENIED`.

Task fields are `id`, `project_id`, `key`, `title`, `description`, `priority`,
`status`, `position`, `version`, `created_by`, `created_by_user_id`, `created_at`,
`updated_at`, `started_at`, `completed_at`, and `cancelled_at`. Dates are ISO
timestamps; nullable fields are `null`. Priorities are `urgent`, `high`,
`medium`, `low`, and `none`. Statuses are `backlog`, `ready`, `claimed`,
`in_progress`, `blocked`, `review`, `done`, and `cancelled`. Human create/move
requests cannot select `claimed`; it is reserved for the agent claim flow.
Task cards additionally include `comment_count` and
`unresolved_blocker_count` (dependencies whose task is not `done`).
`created_by` truthfully discriminates a human or agent author. The nullable
legacy `created_by_user_id` remains populated for historical human-created
tasks and is `null` for agent-created tasks.

`POST /api/v1/projects/:projectId/tasks` accepts `title`, optional
`description`, `priority`, and human-selectable `status`; it requires a non-empty
`Idempotency-Key` header (1–128 characters). Repeating the same key and request
returns the original response. Reusing it for a different request returns
`409 IDEMPOTENCY_CONFLICT`. Omitted `priority` and `status` default to `none`
and `backlog`; the task is appended to that status column. The same idempotency
rule applies to comment creation.

`GET /api/v1/projects/:projectId/tasks` accepts `status`, `priority`, `limit` (1–100,
default 50), and opaque `cursor`. Results are ordered by `position`, then task
ID. The response is `{ "tasks": [...], "total": number, "next_cursor": string | null }`;
`total` is the count for the branch and filters, independent of the current
page. Malformed cursors return `400 VALIDATION_ERROR`. Task keys are unique
per branch; a task copied to another branch keeps its key.

`PATCH /api/v1/tasks/:id` accepts at least one of `title`, `description`, or
`priority`, plus required `expected_version`. `POST /api/v1/tasks/:id/move` accepts a
human-selectable `status`, optional `before_task_id`, and required
`expected_version`. A move inserts before the anchor in the target status
column, or at the end when no anchor is supplied. The anchor must be in that
column. Successful mutations increment `version`. Entering `in_progress`,
`done`, or `cancelled` sets the corresponding lifecycle timestamp; leaving a
status clears that timestamp. Stale versions return
`409 TASK_VERSION_CONFLICT` (with `current_version` when known).

Comments are Markdown in `body_markdown`, with an author profile and
`created_at`. Comment reads accept `limit` and opaque `cursor` and return
`{ "comments": [...], "next_cursor": string | null }`. Dependencies stay within
one branch; a dependency on another branch's task returns
`400 VALIDATION_ERROR` with `details.reason = "cross_branch"`. Adding a
self-edge or cycle returns `409 TASK_DEPENDENCY_CYCLE`.
Dependency changes also require the task's current `expected_version`.
Comments are immutable; there are no comment edit or delete endpoints.

Agent task creation and comments use the same idempotency contract, scoped to
the authenticated agent principal. Agent updates accept `title`, `description`,
`priority`, a human-selectable `status`, optional `acknowledged_through`, and
required `expected_version`; fields and a status change apply as one version
bump. A status change follows the human move rules (appended to the target
column, recorded as `task.moved` with the agent as actor) and is refused with
`409 TASK_NOT_CLAIMABLE` while the task has an active claim:
`details.reason` is `own_claim` when the caller holds it (use set-status,
release or complete instead) and `claimed` otherwise. Moving to `review` or
`done` applies the completion guard: unacknowledged comments by others return
`409 TASK_COMMENTS_UNREAD`, and `acknowledged_through` clears it.

`POST /api/v1/agent/tasks/bulk` takes `{ "tasks": [...] }` with 1–50 agent
create bodies and an `Idempotency-Key` for the whole batch; it returns `201`
with `{ "tasks": [...] }` in input order, keys allocated in that order.
`PATCH /api/v1/agent/tasks/bulk` takes `{ "tasks": [...] }` with 1–50 update
bodies that each add `task_id` (no duplicates) and returns `{ "tasks": [...] }`
in input order. Both run in one transaction: any failure applies nothing and
returns the single-item error code with `details.index` and the item's
`task_id` (update) or `title` (create). Each task emits the same events as the
single route. `GET /api/v1/agent/presence` backs the MCP `list_agents` tool.

Archived projects remain readable, including task lists, task details,
comments, and dependencies. All task writes are rejected with
`409 PROJECT_ARCHIVED` and the message `Archived projects are read-only.`
No frontend wiring is implied by these routes.

## Documents API

Human document routes require the Supabase bearer token and organization
membership for the target project. Agent document routes require exactly one
`Authorization: Bearer orch_agent_...` credential; the credential fixes the
agent and project scope, and request path/body IDs do not override it.

Documents are Markdown on one branch of a project, and paths are unique per
branch. The dashboard uses MDXEditor while the
API stores Markdown text and immutable revisions. `path` must be a normalized,
relative POSIX path: 1–1024 characters, with no leading slash, backslash, NUL,
empty segment, or `.`/`..` segment. `content` is plain text up to 1,000,000
characters. Create requests are `{ "path": "docs/readme.md", "content": "# Notes" }`
and begin at revision 1. Successful create and update responses contain a
`document` object and its new `revision`:

```json
{
  "document": {
    "id": "…",
    "project_id": "…",
    "path": "docs/readme.md",
    "current_revision": 1,
    "created_by": { "type": "human", "id": "…" },
    "created_at": "2026-08-22T00:00:00.000Z",
    "updated_at": "2026-08-22T00:00:00.000Z"
  },
  "revision": {
    "id": "…",
    "document_id": "…",
    "revision_number": 1,
    "content": "# Notes",
    "author": { "type": "human", "id": "…" },
    "created_at": "2026-08-22T00:00:00.000Z"
  }
}
```

`PATCH` accepts `{ "content": "…", "base_revision": 1 }`. The update creates
one immutable revision and advances `current_revision` atomically. A stale
base returns `409 DOCUMENT_CONFLICT` and no revision or event:

```json
{
  "error": {
    "code": "DOCUMENT_CONFLICT",
    "message": "Document revision is stale.",
    "details": { "current_revision": 2, "base_revision": 1 },
    "request_id": "req_…"
  }
}
```

List and history responses use `{ "next_cursor": string | null }`. Document
lists accept `limit` (1–100, default 50) and an opaque `cursor`; results are
ordered by update time and ID. History is returned in revision order and is
immutable. Archived projects remain readable, while document creation and
updates return `409 PROJECT_ARCHIVED`.

Attachments use direct multipart uploads to configured R2-compatible storage.
The API creates upload state and signed part URLs, verifies completion, stores
attachment metadata, and issues short-lived download URLs. The API does not
proxy attachment bytes.

## Agent coordination

Human routes use `Authorization: Bearer <Supabase access token>` and resolve
project access from the user's organization membership. Agent routes require
exactly one `Authorization: Bearer <agent-token>` header. Agent tokens start
with `orch_agent_`; this prefix keeps them from falling through to human
authentication. The credential identifies the agent and project; request body
and path IDs do not change that principal. Agent tokens are random bearer
credentials, stored only as hashes, and returned only when issued. Revoked
credentials fail immediately with `401 AGENT_CREDENTIAL_REVOKED`. An agent
credential is rejected on human routes with `401 AGENT_CREDENTIAL_INVALID`.

Agents open sessions with `runtime` and `integration` metadata, plus optional
`external_session_id`. Sessions are scoped to the authenticated agent. A
session is stale when its heartbeat is more than 60 seconds old; session
heartbeat and claim operations then return `409 AGENT_SESSION_STALE`; an
explicit close is still permitted. Heartbeats update presence and renew that
session's active claim leases. Closing a session revokes its active claims.

Claims require an active session, a `ready` task, and resolved dependencies.
`lease_seconds` defaults to 300 and accepts 30–86,400 seconds. A successful
claim returns a claim record and a claim token; only the owning agent and
session can release or complete it. Release returns the task to `ready`;
completion moves it to `done`. Expired leases are reconciled lazily when tasks
are read or claimed, allowing the task to be reclaimed. Concurrent claims
produce one winner; the loser receives `409 TASK_ALREADY_CLAIMED` with the
active claim and lease details.

Presence is derived from an active session and a fresh heartbeat, with
`online`/`offline` status, any current task, and the session's `branch_id`.
Events are ordered by numeric event ID and paged with `limit` and `after`;
human members and project agents can read the same project event stream,
filtered to a branch as described under [Branches](#branches). Meaningful
agent, credential, session, claim, and task lifecycle mutations write durable
events in their transaction.

## Attention and handoffs

See `docs/agent-attention-handoffs.md` for semantics.

Agent routes, under `/api/v1/agent`:

| Route                                     | Purpose                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /attention`                          | Attention summary: `unread_chats`, watched tasks with unread comments and mentions, pending handoffs, resolved blockers, and a `cursor`          |
| `POST /attention/acknowledge`             | Acknowledge `task_comments`, `handoff` or `blocker` items                                                                                        |
| `POST /tasks/:id/watch`                   | `{ watching }`; `false` mutes the task                                                                                                           |
| `GET /attention/wait`                     | Long-poll, at most 25 s per request. `after` cursor, `timeout_ms` (0 polls), `directed_only`, `kinds`. Returns `pending`, `updates` or `timeout` |
| `POST /sessions/:sessionId/claims/status` | `in_progress`, `blocked` or `review`, using the claim token                                                                                      |
| `POST /handoffs`                          | Direct message plus optional task reference. `Idempotency-Key` required                                                                          |
| `POST /wakes`                             | The local waker records a wake against the server budget                                                                                         |

Human routes, under `/api/v1`:

| Route                                       | Purpose                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /projects/:projectId/attention`        | Attention summary                                                          |
| `GET /projects/:projectId/attention/tasks`  | Per-task overlay: claim, block, unread counts                              |
| `GET /projects/:projectId/attention/agents` | Per agent: waiting since, pending directed items, open block, current task |
| `POST /tasks/:id/watch`                     | Watch or mute                                                              |
| `POST /tasks/:id/comments/read`             | `{ through_sequence }`                                                     |
| `POST /tasks/:id/block/resolve`             | Resolve a block                                                            |
| `POST /projects/:projectId/handoffs`        | Create a handoff. `Idempotency-Key` required                               |

Task comments now carry a per-task `sequence` and `mentions`. The create
request accepts `mentions`, up to 20.

Claim-ending changes:

- `release` and `complete` accept `acknowledged_through`.
- They refuse with `409 TASK_COMMENTS_UNREAD` while comments by others posted
  since the claim remain unacknowledged.

Events:

| Event                  | Payload notes                                     |
| ---------------------- | ------------------------------------------------- |
| `task.status_changed`  |                                                   |
| `task.block_resolved`  |                                                   |
| `chat.handoff_created` | entity is the chat, so chat authorization applies |
| `run.woken`            |                                                   |
| `task.comment_created` | adds `sequence` and `mentions`                    |
| `claim.released`       | adds `reason`                                     |

Errors:

| Code                                                                                | Status |
| ----------------------------------------------------------------------------------- | ------ |
| `TASK_COMMENTS_UNREAD`, `WATCH_LIMIT`, `INVALID_STATUS_TRANSITION`, `BLOCKER_CYCLE` | 409    |
| `WAIT_LIMIT`, `HANDOFF_CHAIN_LIMIT`, `HANDOFF_RATE_LIMITED`, `WAKE_LIMIT`           | 429    |

## Branches

See `docs/project-branches.md` for the design. Every project has branches, and
exactly one of them is the default branch. These belong to one branch: tasks
with their comments, dependencies and claims; documents with their folders,
revisions and attachments; chats with their participants and messages; and
agent sessions. Organizations, projects, members, agents and agent credentials
stay project-wide. Project responses include `default_branch_id`.

### Requests that name no branch

A request that names no branch uses the project's default branch. Clients from
before branches, including the published CLI, keep working unchanged against
the default branch.

The new branch error codes are returned only to requests that name a branch
(`?branch_id=`, `X-Orchestrat-Branch-Id` or `X-Orchestrat-Session-Id`) and on
the branch, merge, decision and repository routes. Older clients parse a closed
list of codes, so a request without a branch signal gets an existing code with
a `details.reason` instead:

| Failure                                         | Response                                              |
| ----------------------------------------------- | ----------------------------------------------------- |
| Claim a task on another branch than the session | `409 TASK_NOT_CLAIMABLE`, `reason: "branch_mismatch"` |
| Claim a task on an archived branch              | `409 TASK_NOT_CLAIMABLE`, `reason: "branch_archived"` |
| Write to an item on an archived branch          | `409 CONFLICT`, `reason: "branch_archived"`           |
| Reference an item on another branch             | `400 VALIDATION_ERROR`, `reason: "cross_branch"`      |

Cross-branch references are task dependencies, blocking tasks, the task in a
handoff, and `document_ids` in chat messages.

### Choosing a branch: people

These human routes accept an optional `branch_id` query parameter (a UUID):

- `GET` and `POST /api/v1/projects/:projectId/tasks`
- `GET` and `POST /api/v1/projects/:projectId/documents`
- `POST /api/v1/projects/:projectId/document-folders`
- `GET` and `POST /api/v1/projects/:projectId/chats`
- `GET /api/v1/projects/:projectId/inbox`
- `GET /api/v1/projects/:projectId/events`
- `POST /api/v1/projects/:projectId/handoffs`

Without `branch_id`, the route uses the default branch. A `branch_id` that is
not a branch of the project returns `404 BRANCH_NOT_FOUND`. Archived branches
stay readable; a create that names one returns `409 BRANCH_ARCHIVED`.

Entity routes (`/tasks/:id…`, `/documents/:id…`,
`/documents/:documentId/attachments…`, `/chats/:id…`) take the branch from the
item and don't read `branch_id`.

Presence, message candidates and the human attention routes
(`/projects/:projectId/attention…`) stay project-wide. Human attention spans
every branch.

### Choosing a branch: agents

Agent routes resolve the branch in this order:

1. **Pinned session.** `X-Orchestrat-Session-Id: <session id>` pins the request
   to that session's branch. A claim pins to the session in its body. If
   `X-Orchestrat-Branch-Id` names a different branch, the request fails with
   `409 BRANCH_MISMATCH`. A session ID that isn't one of the agent's sessions
   returns `404 AGENT_SESSION_NOT_FOUND`.
2. **Header.** `X-Orchestrat-Branch-Id: <branch id>`.
3. **The default branch.**

Both headers must be UUIDs. A malformed value returns `400 VALIDATION_ERROR`
with `details.header` on every agent route.

Agents can read tasks, documents and chats on any branch of their project by
ID. A write to an item on another branch than the one the agent named, or the
one its session is pinned to, returns `409 BRANCH_MISMATCH`. A write without a
branch signal uses the item's branch.

### Sessions, claims and hooks

- `POST /agent/sessions` accepts an optional `branch_id`. Without it, the
  session opens on the header's branch, else the default branch. The session
  stores and returns `branch_id`. Opening a session on an archived branch
  returns `409 BRANCH_ARCHIVED`.
- A claim's task must be on the session's branch.
- `POST /agent/hooks/lifecycle` keeps its strict body. The branch travels in
  `X-Orchestrat-Branch-Id`. `session.started` for a session that already
  exists on another branch returns `409 AGENT_SESSION_CLOSED` with
  `reason: "branch_mismatch"`. `session.ended` also closes the agent's other
  active sessions with the same `external_session_id`.
- Archiving a branch closes every active session on it and revokes their
  claims.

### Events, presence and inbox

- Events carry `branch_id`. `null` marks a project-wide event, such as branch,
  repository, agent and credential events.
- `GET /projects/:projectId/events` and `GET /agent/events` return the resolved
  branch's events plus project-wide events. On the human route,
  `all_branches=true` returns every branch. The dashboard's realtime catch-up
  uses it to keep one cursor. Cursors stay the global event ID.
- Presence lists every active agent of the project. Each entry's `branch_id`
  is its session's branch, or `null` when the agent is offline.
- `GET /projects/:projectId/inbox` and `GET /agent/inbox` cover the resolved
  branch. On the human route, `all_branches=true` covers every branch and adds
  `branch_id` to each unread chat.
- Messages and comments copied by an import or merge carry `imported_at`.
  Imported messages never count as unread or as mentions, and imported
  comments never count as unread in attention or block `complete` and
  `release` with `TASK_COMMENTS_UNREAD`.
- Realtime envelopes add `branch_id` when the event has one. The realtime
  entity types add `branch`, `merge`, `decision` and `repository`.
- `repository.status_changed` (project-wide) records each change of a
  connection's status, with `{ provider, from, status, reason }`.
- A merged pull request from a fork records a run with `status: "skipped"` and
  `skip_reason: "fork"`, so merge history shows that it was ignored.

### Idempotency

`Idempotency-Key` on task and chat creation is scoped to the branch, so one key
on two branches creates two items. On the default branch, a key first used
before branches existed still replays its original response.

`POST /projects/:projectId/merges` requires `Idempotency-Key`. Keys are scoped
to the user and the target branch.

### Branch routes

Human routes, under `/api/v1`:

| Route                                                     | Who         | Behavior                                                                                                                                           |
| --------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /projects/:projectId/branches`                       | member      | Active branches first, the default first, then the most recently updated. `include_archived=true` adds archived ones; `name` filters by exact name |
| `POST /projects/:projectId/branches`                      | member      | `{ name }`; `201 { branch }`. `409 BRANCH_NAME_TAKEN` when an active branch has the name                                                           |
| `GET /projects/:projectId/branches/:branchId`             | member      | `{ branch }`                                                                                                                                       |
| `POST /projects/:projectId/branches/:branchId/default`    | owner/admin | Makes it the default. `409 BRANCH_ARCHIVED` for an archived branch                                                                                 |
| `POST /projects/:projectId/branches/:branchId/archive`    | owner/admin | Archives it: read-only, hidden by default, nothing deleted. Closes its agent sessions. `409 CONFLICT`, `reason: "default_branch"` for the default  |
| `POST /projects/:projectId/branches/:branchId/onboarding` | member      | `{ "choice": "blank" }` finishes the branch's setup. `409 CONFLICT`, `reason: "onboarding_completed"` when it is already done                      |

Agent routes, under `/api/v1/agent`:

| Route                     | Behavior                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /branches`           | `include_archived`, `name`; `{ branches }`                                                                                                 |
| `GET /branches/:branchId` | `{ branch }`                                                                                                                               |
| `POST /branches/register` | `{ name, git_default_branch?, head_sha?, force_new? }`; `200 { branch, created }`. Returns the active branch with that name, or creates it |

`POST /branches/register` refuses to revive a branch the provider deleted:
when only archived branches have the name and the newest was deleted on the
provider, it returns `409 BRANCH_ARCHIVED` with `branch_id` and `archived_at`.
`force_new: true` creates a new branch anyway. `git_default_branch` is the
checkout's `origin/HEAD` branch. It renames the default branch when that is
still the fallback `main`, no repository is connected, and no active branch has
the name.

An agent credential can create at most 10 branches a minute. A registration
that would create the eleventh gets `429 RATE_LIMITED` with `Retry-After`;
registering a branch that already exists is never limited.

Agents can't archive, merge, import, set the default or resolve decisions.

The branch object is `{ id, project_id, name, is_default, name_source,
created_via, created_by, onboarding_state, onboarding_choice, archived_at,
archived_reason, provider, open_decision_count, created_at, updated_at }`.
`provider` is `null` without a connected repository, otherwise
`{ provider, state, head_sha }` with `state` `tracked`, `missing` or
`untracked`. `archived_reason` is `provider_deleted`, `manual` or
`replaced_on_connect`.

Branch names are 1–255 characters and follow a subset of
`git check-ref-format`: no spaces, control characters or `~ ^ : ? * [ \`; no
leading `-` or `/`; no trailing `/` or `.lock`; no `..`, `//` or `@{`; and not
`@`. Names are unique among active branches only.

### Imports, merges and decisions

Human routes only, under `/api/v1`:

| Route                                                     | Who                   | Behavior                                                                                                                                                                   |
| --------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /projects/:projectId/merges/preview`                | member or owner/admin | `{ source_branch_id, target_branch_id, kind, selection? }`; `{ preview }`. `409 BRANCH_ARCHIVED` when the target is archived                                               |
| `POST /projects/:projectId/merges`                        | member or owner/admin | `Idempotency-Key` required. `{ source_branch_id, target_branch_id, kind, selection?, choices, preview_fingerprint, archive_source?, complete_onboarding? }`; `201 { run }` |
| `GET /projects/:projectId/merges`                         | member                | `branch_id` (source or target), `limit` (1–100, default 50), `cursor`; `{ runs, next_cursor }`, newest first                                                               |
| `GET /projects/:projectId/decisions`                      | member                | `branch_id` (target), `status`; `{ decisions }`, newest first                                                                                                              |
| `POST /projects/:projectId/decisions/:decisionId/resolve` | owner/admin           | `{ "choice": "use_source" \| "use_target" }`; `{ decision }`                                                                                                               |

`kind` is `import` or `merge`. Members import into any branch except the
default. A merge, an import into the default branch, and `archive_source: true`
need an owner or admin, for the preview as well as the apply.

- **Selection.** An import takes `{ tasks, documents, chats }`, each `"all"` or
  a list of up to 2,000 lineage keys. A merge always takes everything.
  Selecting a task also brings the tasks it depends on that the target lacks.
- **Preview.** Each item has `item_type`, `lineage_key`, `source_id`,
  `target_id`, `outcome` (`copy`, `apply`, `unchanged`, `keep_target`,
  `conflict` or `skipped`), `reason`, `fields`, `required_by`, `label`,
  `task_key`, `audience`, `source_values` and `target_values`. `counts` totals
  outcomes per item type. `fingerprint` covers every version the apply
  depends on.
- **Apply.** The apply re-plans under the project lock. If its fingerprint no
  longer matches `preview_fingerprint`, it returns `409 BRANCH_PREVIEW_STALE`
  with the new preview in `details.preview`. An import must choose
  `use_source` or `use_target` in `choices` for every conflict, otherwise
  `400 VALIDATION_ERROR` with `reason: "missing_choice"` and `lineage_keys`.
- **Merges never ask.** A conflict keeps the target's version and becomes a
  decision. A task with an active claim on the target is never changed.
- **Limits.** A run takes at most 2,000 top-level items, 20,000 comments and
  messages, and 5 GiB of attachments; beyond that, `400 VALIDATION_ERROR` with
  `reason: "too_large"`. The source and target must differ
  (`reason: "same_branch"`), and the default branch can't be archived
  (`reason: "default_branch"`). Copied attachments count toward the project
  quota (`409 ATTACHMENT_QUOTA_EXCEEDED`) and need document storage
  (`503 STORAGE_UPLOAD_FAILED` otherwise).
- **Events.** A run emits one `merge.import_applied` or `merge.merge_applied`
  event on the target branch, never one per item, plus `decision.opened` with
  the count when it created decisions.
- **Resolving.** `use_target` keeps the target and records the source state as
  agreed, so the same source won't conflict again. `use_source` applies the
  recorded source values when the target hasn't changed since the merge. If it
  has, the response is `409 BRANCH_DECISION_STALE` with the refreshed decision
  in `details.decision`; if the target already matches the source, the
  decision settles as `resolved_source`. `use_source` on a claimed task
  returns `409 TASK_ALREADY_CLAIMED`. A settled decision returns
  `409 CONFLICT` with `reason: "decision_closed"`.

A run is `{ id, project_id, source_branch_id, target_branch_id, kind, trigger,
status, skip_reason, provider, counts, skipped, decision_count, created_by,
created_at, applied_at }`. `trigger` is `dashboard` or `provider_merge`. A
decision has `reason` `changed_on_both`, `added_on_both`, `path_collision` or
`target_claimed`, and `status` `open`, `resolved_source`, `resolved_target` or
`superseded`.

### Repository connections

Human routes, under `/api/v1/projects/:projectId`:

| Route                                                                  | Who                    | Behavior                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /repository`                                                      | member                 | `{ repository, providers }`. `repository` is the active connection or `null`; each provider has `configured` and `unavailable_reason`                                                                                                                                   |
| `POST /repository/authorizations`                                      | owner/admin            | `{ provider, return_path? }`; `{ authorization_id, authorize_url, expires_at }`. The authorization expires after 15 minutes                                                                                                                                             |
| `POST /repository/authorizations/:authorizationId/github-installation` | owner/admin, same user | `{ installation_id }` from the GitHub Setup URL, which is untrusted; `{ "next": "pick_repository" }` once the user's GitHub token lists the installation                                                                                                                |
| `GET /repository/authorizations/:authorizationId/repositories`         | owner/admin, same user | `{ repositories, install_url }`. Each repository has `provider_repository_id`, `full_name`, `default_branch`, `eligible` and `ineligible_reason`. GitHub sets `install_url`, where people install the app when a repository isn't listed; other providers return `null` |
| `POST /repository`                                                     | owner/admin, same user | `{ authorization_id, provider_repository_id, default_branch_mapping, create_existing_branches }`; `201 { repository }`                                                                                                                                                  |
| `POST /repository/sync`                                                | owner/admin            | Queues a reconcile; `202 { "queued": true }`                                                                                                                                                                                                                            |
| `POST /repository/hook/reenable`                                       | owner/admin            | GitLab sends a test delivery to wake a disabled project hook, then a reconcile refreshes its health; `202 { "queued": true }`. Other providers: `409 CONFLICT`, `reason: "no_hook"`                                                                                     |
| `GET /repository/deliveries`                                           | owner/admin            | Optional `status`; the newest 100 deliveries                                                                                                                                                                                                                            |
| `POST /repository/deliveries/:deliveryId/retry`                        | owner/admin            | Puts a failed delivery back in line; `{ delivery }`                                                                                                                                                                                                                     |
| `DELETE /repository`                                                   | owner/admin            | `204`. Branches and their work are kept. For GitLab, the hook is deleted and the tokens are revoked                                                                                                                                                                     |

`provider` is `github`, `gitlab` or `origin`. `default_branch_mapping` links the
project's default branch to the provider's default branch `D`:

- `{ "mode": "rename_default" }`, the default: the default branch is renamed
  to `D`. Another active branch named `D` is archived with reason
  `replaced_on_connect`; its work stays importable.
- `{ "mode": "use_existing", "branch_id": "…" }`: the active branch named `D`
  becomes the default, and the old default stays an ordinary branch.

`create_existing_branches` (default `false`) also creates branches for the
provider's other branches. Otherwise each one gets a branch on its first push.

`GET /api/v1/repository/authorizations/pending?provider=github` (not under a
project) returns the signed-in person's newest authorized attempt for that
provider: `{ authorization_id, project_id, provider, expires_at }`, or
`404 NOT_FOUND`. GitHub's Setup URL can open in a browser that didn't start
the flow, so the dashboard looks the attempt up there.

Sync, re-enable, retry and disconnect return `404 NOT_FOUND` when no repository
is connected. A provider that doesn't answer gives `502 INTERNAL_ERROR`; lost
provider access gives `409 REPOSITORY_AUTHORIZATION_INVALID`. There is no
reauthorization route: disconnect and connect again, and branches and their
work are kept.

Public routes, under `/api/v1`, without authentication:

| Route                                 | Purpose                                                                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /repository/callback/:provider`  | Provider redirect for `github`, `gitlab` or `origin`. Always a `302` to the dashboard, with `repository_authorization=<id>` or `repository_error=invalid_state`, `expired` or `authorization_failed` |
| `POST /webhooks/github`               | GitHub App webhooks                                                                                                                                                                                  |
| `POST /webhooks/gitlab/:connectionId` | GitLab project hook, one per connection                                                                                                                                                              |
| `POST /webhooks/origin`               | Cursor Origin app webhooks                                                                                                                                                                           |

Webhooks are verified on the raw body (up to 10 MiB) and limited to 600
requests per minute per IP. They answer:

- `202` when the delivery is stored, is a duplicate, or is valid but for no
  connected repository (stored as `ignored`);
- `401` for a bad signature or timestamp;
- `404` when the provider isn't configured, or the GitLab connection is unknown
  or disconnected;
- `503` when the database is unavailable.

The sync worker applies stored deliveries later; see the
[architecture](../architecture/README.md#repository-sync--current).

### Branch errors

| Code                               | Status | When                                                                                                                                                                           |
| ---------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BRANCH_NOT_FOUND`                 | 404    | The branch isn't a branch of this project                                                                                                                                      |
| `BRANCH_ARCHIVED`                  | 409    | A write names an archived branch, including opening a session there, making it the default, or importing or merging into it; or `register` names a branch the provider deleted |
| `BRANCH_MISMATCH`                  | 409    | The named branch differs from the pinned session's, or an agent writes to an item on another branch                                                                            |
| `BRANCH_NAME_TAKEN`                | 409    | An active branch already has the name                                                                                                                                          |
| `BRANCH_PREVIEW_STALE`             | 409    | The branches changed since the preview; `details.preview` holds the new one                                                                                                    |
| `BRANCH_DECISION_STALE`            | 409    | The target changed since the decision was recorded; `details.decision` holds the refreshed one                                                                                 |
| `REPOSITORY_NOT_CONFIGURED`        | 400    | The provider isn't set up on this server                                                                                                                                       |
| `REPOSITORY_AUTHORIZATION_INVALID` | 409    | The authorization is missing, used, expired or another user's; the installation isn't the user's; provider access was revoked; or the repository can't be connected            |
| `REPOSITORY_CONNECTION_EXISTS`     | 409    | The project already has a repository, or the repository is connected to another project                                                                                        |

Existing codes gain these `details.reason` values:

| Code                       | Reasons                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `400 VALIDATION_ERROR`     | `cross_branch`, `same_branch`, `too_large`, `missing_choice`, `default_branch`                          |
| `409 CONFLICT`             | `branch_archived`, `default_branch`, `onboarding_completed`, `decision_closed`, `path_taken`, `no_hook` |
| `409 TASK_NOT_CLAIMABLE`   | `branch_mismatch`, `branch_archived`                                                                    |
| `409 AGENT_SESSION_CLOSED` | `branch_mismatch`                                                                                       |

## Deferred or externally unverified

The API does not currently implement:

- Task deletion
- Remote MCP/OAuth and detailed tool telemetry
- Agent capability matching or auto-assignment
- Local filesystem document synchronization and collaborative cursors
- Multi-user team collaboration beyond the single-developer private alpha

These items have no implied timeline.

Hosted deployment, production R2 configuration, native distribution, and
clean-Mac multi-agent acceptance are not verified by this source checkout.
Repository connections are tested against simulated providers only; live
GitHub, GitLab.com and Cursor Origin acceptance has not run. See
`docs/acceptance/2026-09-30-project-branches.md`.

## Errors and request IDs

Every response includes an `x-request-id` header. Errors use:

```json
{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "You do not have access to this project.",
    "details": {},
    "request_id": "req_..."
  }
}
```

Current codes are `UNAUTHENTICATED`, `PERMISSION_DENIED`, `VALIDATION_ERROR`,
`NOT_FOUND`, `CONFLICT`, `PROJECT_ARCHIVED`, `TASK_VERSION_CONFLICT`,
`TASK_DEPENDENCY_CYCLE`, `IDEMPOTENCY_CONFLICT`, `AGENT_NOT_FOUND`,
`AGENT_CREDENTIAL_INVALID`, `AGENT_CREDENTIAL_REVOKED`,
`AGENT_SESSION_NOT_FOUND`, `AGENT_SESSION_CLOSED`, `AGENT_SESSION_STALE`,
`TASK_NOT_CLAIMABLE`, `TASK_ALREADY_CLAIMED`, `CLAIM_NOT_FOUND`,
`CLAIM_TOKEN_INVALID`, `CLAIM_NOT_OWNER`, `DOCUMENT_ARCHIVED`,
`DOCUMENT_CONFLICT`, `DOCUMENT_CONTENT_UNAVAILABLE`, `DOCUMENT_EDIT_MISMATCH`,
`ATTACHMENT_QUOTA_EXCEEDED`, `ATTACHMENT_UPLOAD_EXPIRED`,
`STORAGE_UPLOAD_FAILED`, and `INTERNAL_ERROR`, plus the attention codes above
and the branch codes `BRANCH_NOT_FOUND`, `BRANCH_ARCHIVED`, `BRANCH_MISMATCH`,
`BRANCH_NAME_TAKEN`, `BRANCH_PREVIEW_STALE`, `BRANCH_DECISION_STALE`,
`REPOSITORY_NOT_CONFIGURED`, `REPOSITORY_AUTHORIZATION_INVALID`, and
`REPOSITORY_CONNECTION_EXISTS` (see [Branch errors](#branch-errors)).
